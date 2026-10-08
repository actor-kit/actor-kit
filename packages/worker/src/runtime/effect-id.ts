/**
 * Effect ids (ADR-015 D1): `${seq}:${index}`.
 *
 * `seq` is the sequence number of the transition that declared the effect (the journal seq, or
 * the snapshot counter with `journal: false`); `index` counts that transition's effects in
 * declaration order. The id is deterministic, so replay and restore can match an effect to the
 * row it produced, and retries reuse it as an idempotency key.
 */

export interface EffectIdParts {
  readonly seq: number;
  readonly index: number;
}

const EFFECT_ID = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;

export function formatEffectId(seq: number, index: number): string {
  return `${seq}:${index}`;
}

/** Parse `seq:index`; anything else (including legacy `outbox-…` ids) is null. */
export function parseEffectId(id: string): EffectIdParts | null {
  const match = EFFECT_ID.exec(id);
  if (match === null) return null;
  return { seq: Number(match[1]), index: Number(match[2]) };
}
