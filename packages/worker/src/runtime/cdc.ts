/**
 * CDC (Change Data Capture) — append-only change log for audit/replay.
 *
 * After each transition, a ChangeEntry is inserted into the change_log table.
 * Captures: event type, caller, role, checksums (before/after), timestamp.
 */

export interface ChangeEntry {
  id: string;
  eventType: string;
  caller: string;
  role: string;
  prevChecksum: string;
  nextChecksum: string;
  timestamp: number;
}

let cdcCounter = 0;

export function createChangeEntry(params: {
  eventType: string;
  caller: string;
  role: string;
  prevChecksum: string;
  nextChecksum: string;
}): ChangeEntry {
  cdcCounter += 1;
  return {
    id: `cdc-${Date.now()}-${cdcCounter}`,
    eventType: params.eventType,
    caller: params.caller,
    role: params.role,
    prevChecksum: params.prevChecksum,
    nextChecksum: params.nextChecksum,
    timestamp: Date.now(),
  };
}
