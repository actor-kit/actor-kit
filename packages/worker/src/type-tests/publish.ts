/** Type-level tests (checked by `pnpm typecheck`): publish.events names declared events (ADR-017 §3). */
import { z } from "zod";
import { defineActor } from "../define";
import { queue } from "../runtime/env";

const base = {
  input: z.object({}),
  init: () => ({}),
  roles: { any: () => true },
  views: {},
  events: { Placed: z.object({ n: z.number() }), Noted: z.object({}) },
};

export const ok = defineActor("ok", { ...base, publish: { queue: "Q", events: ["Placed", "Noted"] } });

// @ts-expect-error "Nope" is not a declared event
export const bad = defineActor("bad", { ...base, publish: { queue: "Q", events: ["Placed", "Nope"] } });

export const none = defineActor("none", {
  input: z.object({}),
  init: () => ({}),
  roles: { any: () => true },
  views: {},
  // @ts-expect-error no events are declared
  publish: { queue: "Q", events: ["Placed"] },
});

// With a typed env (ADR-016 §4), the queue must be one of its bindings: the parsed env keeps only
// declared keys, so an undeclared queue could never be sent to.
const typedEnv = z.object({ GAME_EVENTS: queue(), API_KEY: z.string() });

export const declaredQueue = defineActor("declared-queue", {
  ...base,
  env: typedEnv,
  publish: { queue: "GAME_EVENTS", events: ["Placed"] },
});

export const undeclaredQueue = defineActor("undeclared-queue", {
  ...base,
  env: typedEnv,
  // @ts-expect-error "OTHER" is not a binding in env
  publish: { queue: "OTHER", events: ["Placed"] },
});
