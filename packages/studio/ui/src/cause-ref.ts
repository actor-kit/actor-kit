/**
 * Cause ids (ADR-017 §4): an event is `${actorType}/${actorId}/${seq}`, an effect
 * `${actorType}/${actorId}/${seq}:${index}`. Actor ids may contain `/`; types and seqs do not.
 */
export interface CauseRef {
  readonly actorType: string;
  readonly actorId: string;
  readonly seq: number;
  readonly index?: number;
}

const CAUSE_ID = /^([^/]+)\/(.+)\/(0|[1-9]\d*)(?::(0|[1-9]\d*))?$/;

/** The actor and event a cause id points at, or null when it is not one. */
export function parseCauseRef(id: string): CauseRef | null {
  const match = CAUSE_ID.exec(id);
  if (match === null) return null;
  const [, actorType = "", actorId = "", seq = "", index] = match;
  const ref = { actorType, actorId, seq: Number(seq) };
  return index === undefined ? ref : { ...ref, index: Number(index) };
}
