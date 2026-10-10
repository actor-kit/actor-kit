/**
 * What an effect knows about itself (ADR-016 §1).
 *
 * An effect id (`seq:index`) is unique only within one actor. The idempotency key adds the actor
 * (`${actorType}/${actorId}/${effectId}`), so it is unique across a deployment: services pass it
 * to payment and email APIs, and a forward's target dedupes on it. Retries reuse it.
 *
 * A service's `fn(input, env, effect)` gets `EffectInfo` (with the try's AbortSignal); a forward's
 * target gets the same fields without the signal as `ctx.delivery` (`DeliveryInfo`).
 */

import type { DeliveryInfo } from "@actor-kit/core";
import { z } from "zod";

export type { DeliveryInfo };

export interface EffectInfo extends DeliveryInfo {
  /** Aborted when the try times out, or when a redrive, restore or shutdown cancels it (ADR-016 §3). */
  readonly signal: AbortSignal;
}

export function idempotencyKey(actorType: string, actorId: string, effectId: string): string {
  return `${actorType}/${actorId}/${effectId}`;
}

interface EffectFields {
  readonly actorType: string;
  readonly actorId: string;
  readonly effectId: string;
  /** 1-based. */
  readonly attempt: number;
}

/** The metadata a forward carries to its target. */
export function deliveryInfo(fields: EffectFields): DeliveryInfo {
  const { actorType, actorId, effectId, attempt } = fields;
  return { actorType, actorId, effectId, idempotencyKey: idempotencyKey(actorType, actorId, effectId), attempt };
}

/** A service try's third argument. */
export function effectInfo(fields: EffectFields & { readonly signal: AbortSignal }): EffectInfo {
  return { ...deliveryInfo(fields), signal: fields.signal };
}

/** A forward's metadata as its target receives it over RPC (parsed at that boundary). */
export const DeliveryInfoSchema = z.object({
  actorType: z.string().min(1),
  actorId: z.string().min(1),
  effectId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  attempt: z.number().int().min(1),
});
