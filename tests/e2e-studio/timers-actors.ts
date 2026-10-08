/**
 * Oven: a durable timer (ADR-015 D2) for Studio's Timers panel. BAKE schedules `done` under the
 * key `bake` with the dish and a secret (redacted in Studio); the timer marks the dish baked.
 */

import { schema, string, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message, timer } from "@actor-kit/worker";
import { z } from "zod";

type OvenState = { baking: string; baked: string[] };

const Dish = z.object({ dish: z.string(), secret: z.string() });

export const OvenContract = defineActor("oven", {
  input: z.object({}),
  init: (): OvenState => ({ baking: "", baked: [] }),
  roles: { cook: () => true },
  messages: {
    BAKE: message(
      z.object({ dish: z.string().min(1), inMs: z.number().int().nonnegative() }),
      (state: OvenState, { dish, inMs }, ctx) => {
        ctx.schedule("done", { in: inMs, key: "bake", payload: { dish, secret: `recipe-for-${dish}` } });
        return { ...state, baking: dish };
      },
    ),
  },
  timers: {
    done: timer(Dish, (state: OvenState, { dish }) => ({ baking: "", baked: [...state.baked, dish] })),
  },
  views: {
    cook: view.shared(schema({ baking: string, baked: uint32 }), (state: OvenState) => ({
      baking: state.baking,
      baked: state.baked.length,
    })),
  },
  studio: { enabled: true, redact: ["secret"] },
});

export const Oven = createActorClass(OvenContract);
