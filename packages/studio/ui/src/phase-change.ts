/**
 * States (ADR-017 §1, nested in ADR-019 A): an actor with `states` persists
 * `{ shared, phase, locals, stateTimers }`, `phase` being the active path (`["playing", "window"]`).
 * Entries written before 0.3 have a flat phase name. The State panel names the path and the timeline
 * marks the entries where it changed.
 */
import type { TimelineItem } from "./protocol";

function isPath(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string");
}

/** A state's phase as a dotted path (`playing.window`); null when it has none. */
export function phasePath(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("phase" in state)) return null;
  const { phase } = state;
  if (typeof phase === "string") return phase;
  return isPath(phase) ? phase.join(".") : null;
}

/** An entry's phase; null when it has none (an entry whose state is unavailable has a null state). */
function phaseOf(item: TimelineItem | undefined): string | null {
  return item === undefined ? null : phasePath(item.state);
}

/** The phase this entry entered, when it differs from the previous (older) entry's. */
export function phaseChange(entry: TimelineItem, previous: TimelineItem | undefined): string | null {
  const phase = phaseOf(entry);
  const before = phaseOf(previous);
  return before !== null && phase !== before ? phase : null;
}
