/**
 * Timers whose payload is optional or nullable (Catancast, 2026-10-18): a timer scheduled without a
 * payload is stored as null (JSON has no undefined); firing it must give the handler what
 * simulate() gives it, not drop the timer because null fails `z.object({}).optional()`.
 */
import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message, timer } from "@actor-kit/worker";
import { z } from "zod";

export type OptionalTimersState = { fired: { name: string; payload: string }[] };

type Ctx = { schedule(name: string, opts: { in?: number; key?: string; payload?: unknown }): void };

/** How a handler saw its payload: "undefined", "null", or the JSON. */
const seen = (payload: unknown): string => (payload === undefined ? "undefined" : JSON.stringify(payload));
const fired = (s: OptionalTimersState, name: string, payload: unknown): OptionalTimersState => ({
  fired: [...s.fired, { name, payload: seen(payload) }],
});

export const OptionalTimersContract = defineActor("optional-timers", {
  input: z.object({}),
  init: (): OptionalTimersState => ({ fired: [] }),
  roles: { player: () => true },
  messages: {
    /** Schedule `name` in `inMs`, with the payload only when the message carries one. */
    LATER: message(
      z.object({
        name: z.enum(["bot", "maybe", "nullish", "plain"]),
        inMs: z.number(),
        payload: z.unknown().optional(),
      }),
      (s: OptionalTimersState, { name, inMs, payload }, ctx: Ctx) => {
        ctx.schedule(name, { in: inMs, key: name, ...(payload === undefined ? {} : { payload }) });
        return s;
      },
    ),
  },
  timers: {
    bot: timer(z.object({}).optional(), (s: OptionalTimersState, payload) => fired(s, "bot", payload)),
    maybe: timer(z.object({ n: z.number() }).nullable(), (s: OptionalTimersState, payload) =>
      fired(s, "maybe", payload),
    ),
    nullish: timer(z.object({ n: z.number() }).nullish(), (s: OptionalTimersState, payload) =>
      fired(s, "nullish", payload),
    ),
    plain: timer(z.undefined(), (s: OptionalTimersState, payload) => fired(s, "plain", payload)),
  },
  views: {
    player: view.shared(schema({ fired: uint32 }), (s: OptionalTimersState) => ({ fired: s.fired.length })),
  },
});

export const OptionalTimers = createActorClass(OptionalTimersContract);
