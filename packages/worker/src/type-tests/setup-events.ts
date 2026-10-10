/**
 * Type-level tests (checked by `pnpm typecheck`, never run): setup({ events }) types ctx.emit
 * (ADR-017 §2). Each @ts-expect-error must be an error, or the typecheck fails.
 */
import { z } from "zod";
import { setup } from "../setup";

type S = { n: number };
const kit = setup({
  events: {
    Bumped: z.object({ by: z.number() }),
    Reset: z.object({}),
  },
});

export const typedEmit = kit.message(z.object({ by: z.number() }), (s: S, { by }, ctx) => {
  ctx.emit("Bumped", { by });
  ctx.emit("Reset", {});
  // @ts-expect-error not a declared event
  ctx.emit("Nope", {});
  // @ts-expect-error wrong payload type
  ctx.emit("Bumped", { by: "1" });
  // @ts-expect-error missing payload field
  ctx.emit("Bumped", {});
  return { n: s.n + by };
});

export const guarded = kit.message(z.object({}), {
  guard: (s: S) => s.n > 0,
  handler: (s: S, _p, ctx) => {
    // @ts-expect-error not a declared event
    ctx.emit("Nope", {});
    return s;
  },
});

export const typedTimerEmit = kit.timer(z.object({}), (s: S, _p, ctx) => {
  ctx.emit("Reset", {});
  // @ts-expect-error wrong payload
  ctx.emit("Reset", { by: 1 });
  return s;
});

export const declared: { Bumped: z.ZodType; Reset: z.ZodType } = kit.events;
