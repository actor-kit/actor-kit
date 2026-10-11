/**
 * Stamp: a handler that reads Date.now() directly, under each `determinism` mode (ADR-018 E).
 * Default ("warn"): accepted, the journal entry flagged. "throw": refused. "off": accepted, unflagged.
 */

import { createActorClass, setup } from "@actor-kit/worker";
import { z } from "zod";

type StampState = { stamps: number };

const stamp = setup({});

const def = (determinism?: "throw" | "warn" | "off") => ({
  input: z.object({}),
  init: (): StampState => ({ stamps: 0 }),
  roles: { any: () => true },
  messages: {
    // biome-ignore lint/plugin: the fixture reads the clock on purpose, to test each determinism mode
    STAMP: stamp.message(z.object({}), (s: StampState) => ({ stamps: s.stamps + (Date.now() > 0 ? 1 : 0) })),
    SAFE: stamp.message(z.object({}), (s: StampState, _p, ctx) => ({ stamps: s.stamps + (ctx.now() > 0 ? 1 : 0) })),
  },
  views: { any: { fn: (s: StampState) => s } },
  ...(determinism === undefined ? {} : { determinism }),
});

export const StampWarn = createActorClass(stamp.actor("stamp-warn", def()));
export const StampThrow = createActorClass(stamp.actor("stamp-throw", def("throw")));
export const StampOff = createActorClass(stamp.actor("stamp-off", def("off")));
