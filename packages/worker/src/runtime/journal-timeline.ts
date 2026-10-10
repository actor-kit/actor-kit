/**
 * One history (ADR-017 §5): Studio's timeline, read from the journal.
 *
 * An entry is a journal event: `id` = `seq`, its cause in the shape Studio shows, and the state
 * after it. The after-state comes from a checkpoint at that seq or is replayed through the step
 * core from the newest checkpoint before it (or from init), and must match the checksum recorded
 * with the event. When it cannot be rebuilt (a pruned journal with no checkpoint before it, an
 * event written by another code version, a replay that diverges) it is `null`: Studio never shows
 * a state the actor did not have. Journal retention (`journal.keep`) is the timeline's retention.
 *
 * Pure over the structural `JournalSql`: the Durable Object reads, then projects (redacts) the
 * entries through studio-project.ts before they leave it.
 */

import { xxh64 } from "@actor-kit/core";
import { z } from "zod";
import {
  checkpointPoint,
  type FoldPoint,
  foldEvent,
  JOURNAL_EVENT_COLUMNS,
  type JournalCheckpoint,
  type JournalEvent,
  type JournalSql,
  parseCheckpointRow,
  parseJournalEventRow,
  type ReplayableDef,
} from "./journal";
import type { StudioTimelineEntry } from "./studio-protocol";

/** What reading a timeline needs besides storage. */
export interface TimelineSource {
  readonly def: ReplayableDef;
  /** The source actor type Studio shows for a link (the linked contract's binding name). */
  sourceType(link: string): string;
  readonly env?: unknown;
}

// --- Causes ---

const UNKNOWN = "unknown";

const ServiceDone = z.object({ input: z.unknown(), result: z.unknown() });
const ServiceError = z.object({ input: z.unknown(), error: z.object({ message: z.string() }) });
const LinkUpdate = z.object({ sourceId: z.string(), view: z.unknown() });
const LinkError = z.object({ targetId: z.string(), error: z.object({ message: z.string() }) });
const Timer = z.object({ key: z.string(), payload: z.unknown(), fireAt: z.number(), lateBy: z.number() });
const RecordSchema = z.record(z.string(), z.unknown());

/** The event's payload as a record ({} when it is not one, e.g. an older or foreign row). */
function payloadRecord(event: JournalEvent): Record<string, unknown> {
  const parsed = RecordSchema.safeParse(event.payload);
  return parsed.success ? parsed.data : {};
}

function who(event: JournalEvent) {
  return { caller: event.caller ?? UNKNOWN, callerType: event.callerType ?? "user", role: event.role ?? UNKNOWN };
}

type CauseOf = (event: JournalEvent, sourceType: (link: string) => string) => Record<string, unknown>;

const CAUSES: { [K in JournalEvent["causeType"]]: CauseOf } = {
  init: () => ({}),
  migrate: (event) => payloadRecord(event),
  restore: (event) => payloadRecord(event),
  message: (event) => {
    const { caller, callerType, role } = who(event);
    return { messageType: event.name ?? UNKNOWN, caller, callerType, role, payload: event.payload };
  },
  "lifecycle.connect": (event) => who(event),
  "lifecycle.disconnect": (event) => who(event),
  "service.onDone": (event) => {
    const { input, result } = ServiceDone.parse(event.payload);
    return { service: event.name ?? UNKNOWN, input, result };
  },
  "service.onError": (event) => {
    const { input, error } = ServiceError.parse(event.payload);
    return { service: event.name ?? UNKNOWN, input, error: error.message };
  },
  "link.onUpdate": (event, sourceType) => {
    const { sourceId, view } = LinkUpdate.parse(event.payload);
    return { sourceType: linkType(event, sourceType), sourceId, viewData: view };
  },
  "link.onError": (event, sourceType) => {
    const { targetId, error } = LinkError.parse(event.payload);
    return { sourceType: linkType(event, sourceType), sourceId: targetId, error: error.message };
  },
  timer: (event) => {
    const { key, payload, fireAt, lateBy } = Timer.parse(event.payload);
    return { name: event.name ?? UNKNOWN, key, payload, fireAt, lateBy };
  },
};

function linkType(event: JournalEvent, sourceType: (link: string) => string): string {
  return event.name === null ? UNKNOWN : sourceType(event.name);
}

/** A journal event's cause, in the shape Studio shows (the old timeline's `cause_data`). */
export function timelineCause(event: JournalEvent, sourceType: (link: string) => string): Record<string, unknown> {
  return CAUSES[event.causeType](event, sourceType);
}

/** A journal event as a timeline entry, with its after-state (JSON) or null when unknown. */
export function timelineEntry(
  event: JournalEvent,
  stateSnapshot: string | null,
  sourceType: (link: string) => string,
): StudioTimelineEntry {
  return {
    id: event.seq,
    seq: event.seq,
    causeType: event.causeType,
    causeData: JSON.stringify(timelineCause(event, sourceType)),
    stateSnapshot,
    checksum: event.stateChecksum,
    createdAt: event.createdAt,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    emitted: event.emitted === undefined ? null : JSON.stringify(event.emitted),
  };
}

// --- After-states ---

/** A rebuilt point and the state's persisted JSON (what the checksum covers). */
interface Known {
  readonly point: FoldPoint;
  readonly json: string;
}

const FirstSeq = z.object({ seq: z.number() });
const ToSeq = z.object({ toSeq: z.number() });
/** Restore events are folded here, never by foldEvent: it gets no earlier points. */
const NO_POINTS: ReadonlyMap<number, FoldPoint> = new Map();

/** A checkpoint's point, or null when its checksum does not match its state. */
function trusted(def: ReplayableDef, checkpoint: JournalCheckpoint): Known | null {
  if (xxh64(checkpoint.state) !== checkpoint.checksum) return null;
  return { point: checkpointPoint(def, checkpoint), json: checkpoint.state };
}

/** The point, when its persisted state hashes to the checksum the event recorded. */
function verified(def: ReplayableDef, point: FoldPoint, event: JournalEvent): Known | null {
  const json = JSON.stringify(def.serialize ? def.serialize(point.state) : point.state);
  return xxh64(json) === event.stateChecksum ? { point, json } : null;
}

/**
 * Where folding to `lo` starts: the newest checkpoint at or before it, or (none) just before the
 * journal's first event, with nothing known: an `init` event starts from nothing, anything else
 * stays unknown until a checkpoint.
 */
function startPoint(sql: JournalSql, def: ReplayableDef, lo: number): { seq: number; known: Known | null } {
  const [row] = sql.exec("SELECT * FROM journal_checkpoints WHERE seq <= ? ORDER BY seq DESC LIMIT 1", lo).toArray();
  if (row !== undefined) {
    const checkpoint = parseCheckpointRow(row);
    return { seq: checkpoint.seq, known: trusted(def, checkpoint) };
  }
  const first = FirstSeq.parse(sql.exec("SELECT MIN(seq) AS seq FROM events").toArray()[0]).seq;
  return { seq: first - 1, known: null };
}

class Folder {
  constructor(
    private readonly sql: JournalSql,
    private readonly source: TimelineSource,
  ) {}

  /** The rebuilt point after every event in [lo, hi] (null where it cannot be rebuilt). */
  async range(lo: number, hi: number): Promise<Map<number, Known | null>> {
    const { def } = this.source;
    const start = startPoint(this.sql, def, lo);
    const events = this.sql
      .exec(`SELECT ${JOURNAL_EVENT_COLUMNS} FROM events WHERE seq > ? AND seq <= ? ORDER BY seq`, start.seq, hi)
      .toArray()
      .map(parseJournalEventRow);
    const checkpoints = new Map(
      this.sql
        .exec("SELECT * FROM journal_checkpoints WHERE seq > ? AND seq <= ?", start.seq, hi)
        .toArray()
        .map((row): [number, JournalCheckpoint] => {
          const checkpoint = parseCheckpointRow(row);
          return [checkpoint.seq, checkpoint];
        }),
    );
    const out = new Map<number, Known | null>([[start.seq, start.known]]);
    let known = start.known;
    for (const event of events) {
      const checkpoint = checkpoints.get(event.seq);
      known = checkpoint !== undefined ? trusted(def, checkpoint) : await this.next(known, event, out);
      out.set(event.seq, known);
    }
    return out;
  }

  /** The point after `event`, folded onto `known`; null when it cannot be rebuilt or diverges. */
  private async next(
    known: Known | null,
    event: JournalEvent,
    earlier: ReadonlyMap<number, Known | null>,
  ): Promise<Known | null> {
    const { def, env } = this.source;
    if (event.causeType === "restore") return this.restored(event, earlier);
    // init starts from nothing; any other event needs the point before it.
    const from = event.causeType === "init" ? { state: undefined, timers: [] } : known?.point;
    if (from === undefined || event.codeVersion !== (def.version ?? 1)) return null;
    try {
      return verified(def, await foldEvent(def, from, event, NO_POINTS, { env }), event);
    } catch {
      // Not replayable under the current handlers (a handler is gone, non-determinism).
      return null;
    }
  }

  /** A restore event's point is the point at its toSeq (rebuilt here when the range does not hold it). */
  private async restored(event: JournalEvent, earlier: ReadonlyMap<number, Known | null>): Promise<Known | null> {
    const parsed = ToSeq.safeParse(event.payload);
    // A restore goes back: a toSeq at or after the event itself is not a state it can have.
    if (!parsed.success || parsed.data.toSeq >= event.seq) return null;
    const { toSeq } = parsed.data;
    const target = earlier.has(toSeq) ? earlier.get(toSeq) : (await this.range(toSeq, toSeq)).get(toSeq);
    return target?.point === undefined ? null : verified(this.source.def, target.point, event);
  }
}

// --- Pages ---

export interface TimelinePageQuery {
  readonly limit: number;
  /** Exclusive seq cursor: entries older than this one. */
  readonly before?: number | undefined;
}

/** One page of the timeline, newest first, with each entry's after-state. */
export async function readStudioTimeline(
  sql: JournalSql,
  source: TimelineSource,
  query: TimelinePageQuery,
): Promise<{ entries: StudioTimelineEntry[]; hasMore: boolean }> {
  const before = query.before ?? Number.MAX_SAFE_INTEGER;
  const rows = sql
    .exec(
      `SELECT ${JOURNAL_EVENT_COLUMNS} FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?`,
      before,
      query.limit + 1,
    )
    .toArray()
    .map(parseJournalEventRow);
  const events = rows.slice(0, query.limit);
  const oldest = events.at(-1);
  if (oldest === undefined) return { entries: [], hasMore: false };
  const points = await new Folder(sql, source).range(oldest.seq, Math.max(...events.map((e) => e.seq)));
  return {
    entries: events.map((event) => timelineEntry(event, points.get(event.seq)?.json ?? null, source.sourceType)),
    hasMore: rows.length > query.limit,
  };
}
