/** Type-level tests (checked by `pnpm typecheck`): publish.events names declared events (ADR-017 §3). */
import { z } from "zod";
import { defineActor } from "../define";

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
