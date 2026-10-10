/**
 * Actors for tests/integration/publish.test.ts (ADR-017 §3): Lot publishes Placed to the LOT_EVENTS
 * queue; LotUnbound publishes to a queue that is not bound, so its rows retry and dead-letter.
 */
import { createActorClass, defineActor, setup } from "@actor-kit/worker";
import { z } from "zod";

type S = { n: number };
const lot = setup({ events: { Placed: z.object({ n: z.number() }), Noted: z.object({}) } });

const LotContract = defineActor("lot", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: { any: () => true },
  events: lot.events,
  publish: { queue: "LOT_EVENTS", events: ["Placed"] },
  messages: {
    PLACE: lot.message(z.object({ n: z.number() }), (s: S, { n }, ctx) => {
      ctx.emit("Noted", {});
      ctx.emit("Placed", { n });
      return { n: s.n + n };
    }),
  },
  views: {},
});

export const Lot = createActorClass(LotContract);
export const LotUnbound = createActorClass(
  defineActor("lot-unbound", { ...LotContract.def, publish: { queue: "MISSING_QUEUE", events: ["Placed"] } }),
);
