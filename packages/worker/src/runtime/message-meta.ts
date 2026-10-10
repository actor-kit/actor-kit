/**
 * A message's RPC metadata (the 4th argument of `send`).
 *
 * A forward carries two things to its target in one object: its delivery (ADR-016 §1: actor, effect
 * id, idempotency key, try number), which the target's handler reads as `ctx.delivery`, and the flow
 * it continues (ADR-017 §4: correlation and causation ids), journaled with the target's event. A
 * direct send carries neither.
 *
 * Parsed at the boundary: metadata that names any delivery field must be a whole delivery (a target
 * dedupes on it), or the message is refused; a trace that does not parse only starts a new flow.
 */

import { z } from "zod";
import { type DeliveryInfo, DeliveryInfoSchema } from "./effect-info";
import type { Trace } from "./trace";

/** What a forward sends as metadata. */
export type MessageMeta = DeliveryInfo & Trace;

export const TraceSchema = z.object({ correlationId: z.string().min(1), causationId: z.string().min(1) });

const DELIVERY_KEYS = Object.keys(DeliveryInfoSchema.shape);

export type ParsedMessageMeta =
  | { ok: true; delivery: DeliveryInfo | undefined; trace: Trace | undefined }
  | { ok: false; error: "invalid_delivery"; detail: string };

export function forwardMeta(delivery: DeliveryInfo, trace: Trace): MessageMeta {
  return { ...delivery, ...trace };
}

export function parseMessageMeta(meta: unknown): ParsedMessageMeta {
  if (meta === undefined) return { ok: true, delivery: undefined, trace: undefined };
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return { ok: false, error: "invalid_delivery", detail: "message metadata must be an object" };
  }
  const traced = TraceSchema.safeParse(meta);
  const trace = traced.success ? traced.data : undefined;
  if (!DELIVERY_KEYS.some((key) => Object.hasOwn(meta, key))) return { ok: true, delivery: undefined, trace };
  const delivery = DeliveryInfoSchema.safeParse(meta);
  if (!delivery.success) return { ok: false, error: "invalid_delivery", detail: delivery.error.message };
  return { ok: true, delivery: delivery.data, trace };
}
