/**
 * Restore (ADR-015 D3), the pure part: what an actor looks like at an earlier seq, and what the
 * outside world did since that the restored actor must still hear about.
 *
 * - State: the fold up to `toSeq`, from the newest checkpoint at or before it (checksum-verified),
 *   or from init.
 * - Timers: those pending at `toSeq`, with their original effect ids and deadlines (overdue ones
 *   fire on the next alarm).
 * - Redeliver: service results recorded after `toSeq` for executions declared at or before it.
 *   The service already ran (the world saw it), so its recorded result is delivered again as a new
 *   event; the service itself is never called again. One result per effect id.
 *
 * Nothing here touches storage: the Durable Object reads the journal, plans, then commits.
 */

import { z } from "zod";
import { parseEffectId } from "./effect-id";
import {
  checkpointPoint,
  type FoldPoint,
  foldEvents,
  type Journal,
  type JournalEvent,
  type ReplayableDef,
  type ScheduledTimer,
} from "./journal";

export interface RestorePlan {
  readonly state: unknown;
  readonly timers: readonly ScheduledTimer[];
  readonly redeliver: readonly JournalEvent[];
}

const ResultEffect = z.object({ effectId: z.string() });

/** The point folding starts from: the newest checkpoint at or before `toSeq` that the events follow, or init. */
function restoreStart(
  def: ReplayableDef,
  journal: Journal,
  events: readonly JournalEvent[],
  toSeq: number,
): { seq: number; point: FoldPoint } {
  const firstSeq = Math.min(...events.map((e) => e.seq));
  const checkpoint = [...journal.checkpoints]
    .filter((c) => c.seq <= toSeq && c.seq >= firstSeq - 1)
    .sort((a, b) => b.seq - a.seq)[0];
  if (checkpoint !== undefined) return { seq: checkpoint.seq, point: checkpointPoint(def, checkpoint) };
  if (firstSeq === 1) return { seq: 0, point: { state: undefined, timers: [] } };
  throw new Error(`Cannot restore to seq ${toSeq}: the journal is pruned before it`);
}

/** The effect a service result was journaled for (null for other events and older payloads). */
function resultEffect(event: JournalEvent): { id: string; seq: number } | null {
  if (!event.causeType.startsWith("service.")) return null;
  const parsed = ResultEffect.safeParse(event.payload);
  if (!parsed.success) return null;
  const effect = parseEffectId(parsed.data.effectId);
  return effect === null ? null : { id: parsed.data.effectId, seq: effect.seq };
}

/** Recorded service results after `toSeq` for effects declared at or before it, first result per effect. */
function resultsToRedeliver(events: readonly JournalEvent[], toSeq: number): JournalEvent[] {
  const seen = new Set<string>();
  const redeliver: JournalEvent[] = [];
  for (const event of events.filter((e) => e.seq > toSeq)) {
    const effect = resultEffect(event);
    if (effect === null || effect.seq > toSeq || seen.has(effect.id)) continue;
    seen.add(effect.id);
    redeliver.push(event);
  }
  return redeliver;
}

/** toSeq must be a seq the journal has reached. */
function assertInJournal(events: readonly JournalEvent[], toSeq: number): void {
  const lastSeq = Math.max(0, ...events.map((e) => e.seq));
  if (!Number.isInteger(toSeq) || toSeq < 1 || toSeq > lastSeq) {
    throw new Error(`Cannot restore to seq ${toSeq}: the journal runs from 1 to ${lastSeq}`);
  }
}

/** State shapes differ across a version bump: toSeq must have been written by the current version. */
function assertCurrentVersion(def: ReplayableDef, events: readonly JournalEvent[], toSeq: number): void {
  if (def.version === undefined) return;
  const written = events.find((e) => e.seq === toSeq)?.codeVersion ?? def.version;
  if (written < def.version) {
    throw new Error(`Cannot restore to seq ${toSeq}: it was written by version ${written} (current: ${def.version})`);
  }
}

/** Plan a restore of `journal` to `toSeq` (1 to its last seq). Throws when the journal cannot get there. */
export async function planRestore(
  def: ReplayableDef,
  journal: Journal,
  toSeq: number,
  options: { env?: unknown } = {},
): Promise<RestorePlan> {
  const events = [...journal.events].sort((a, b) => a.seq - b.seq);
  assertInJournal(events, toSeq);
  assertCurrentVersion(def, events, toSeq);
  const start = restoreStart(def, journal, events, toSeq);
  const folded = events.filter((e) => e.seq > start.seq && e.seq <= toSeq);
  const point = (await foldEvents(def, start, folded, options)).get(toSeq) ?? start.point;
  return { state: point.state, timers: point.timers, redeliver: resultsToRedeliver(events, toSeq) };
}
