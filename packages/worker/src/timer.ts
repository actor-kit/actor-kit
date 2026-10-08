/**
 * timer() helper — pairs a Zod payload schema with a timer handler (ADR-015 D2).
 *
 *   timers: {
 *     roundEnd: timer(z.object({ round: z.number() }), (state, { round }, ctx) =>
 *       state.round === round ? { ...state, phase: "reveal" } : state),
 *   }
 *
 * Handlers schedule it by name: `ctx.schedule("roundEnd", { in: "30s", key: "round-1", payload: { round: 1 } })`.
 * The payload is validated by the schema when scheduled. A timer has no caller and no role; its
 * handler gets `ctx.key`, `ctx.lateBy` and the effect verbs (execute, forward, schedule, cancel).
 */

import type { TimerContext, TimerDef } from "@actor-kit/core";
import type { z } from "zod";

export function timer<TPayload, TState, TEnv = unknown>(
  schema: z.ZodType<TPayload>,
  handler: (state: TState, payload: TPayload, ctx: TimerContext<TEnv>) => TState,
): TimerDef<TState, TPayload, TEnv> {
  return { schema, handler };
}
