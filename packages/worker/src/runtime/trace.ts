/**
 * Causation and correlation ids (ADR-017 §4).
 *
 * An event's id is `${actorType}/${actorId}/${seq}`; an effect's cause id is
 * `${actorType}/${actorId}/${seq}:${index}` (its effect id, qualified by the actor). A transition
 * that continues a flow (a service result, a timer, a forward received, a link update) carries a
 * `Trace`: the flow's correlation id and what caused it. Anything else starts a flow: its
 * correlation id is its own event id and it has no causation.
 */

export interface Trace {
  readonly correlationId: string;
  readonly causationId: string;
}

export function eventId(actorType: string, actorId: string, seq: number): string {
  return `${actorType}/${actorId}/${seq}`;
}

export function effectCauseId(actorType: string, actorId: string, effectId: string): string {
  return `${actorType}/${actorId}/${effectId}`;
}

/** The ids a journal event is written with. */
export function journalTrace(
  trace: Trace | undefined,
  ownId: string,
): { correlationId: string; causationId: string | null } {
  return trace === undefined
    ? { correlationId: ownId, causationId: null }
    : { correlationId: trace.correlationId, causationId: trace.causationId };
}

export interface CauseRef {
  readonly actorType: string;
  readonly actorId: string;
  readonly seq: number;
  /** Present for an effect's cause id. */
  readonly index?: number;
}

const CAUSE_ID = /^([^/]+)\/(.+)\/(0|[1-9]\d*)(?::(0|[1-9]\d*))?$/;

/** Parse an event or effect cause id; null for anything else. Actor ids may contain `/`. */
export function parseCauseId(id: string): CauseRef | null {
  const match = CAUSE_ID.exec(id);
  if (match === null) return null;
  const [, actorType = "", actorId = "", seq = "", index] = match;
  const ref = { actorType, actorId, seq: Number(seq) };
  return index === undefined ? ref : { ...ref, index: Number(index) };
}
