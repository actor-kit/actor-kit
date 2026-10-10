/**
 * States (ADR-017 §1): an actor with `states` persists `{ shared, phase, local, stateTimers }`.
 * The timeline marks the entries where the phase changed.
 */
import type { TimelineItem } from "./protocol";

function phaseOf(item: TimelineItem | undefined): string | null {
  if (item === undefined || item.stateUnavailable === true) return null;
  const { state } = item;
  if (typeof state !== "object" || state === null || !("phase" in state)) return null;
  return typeof state.phase === "string" ? state.phase : null;
}

/** The phase this entry entered, when it differs from the previous (older) entry's. */
export function phaseChange(entry: TimelineItem, previous: TimelineItem | undefined): string | null {
  const phase = phaseOf(entry);
  const before = phaseOf(previous);
  return phase !== null && before !== null && phase !== before ? phase : null;
}
