/**
 * ADR-016 §1: a forward carries its effect's metadata to the target. The target's message handler
 * reads it as `ctx.delivery` (undefined for messages that did not come through a forward) and can
 * dedupe a retried forward on `ctx.delivery.idempotencyKey`. It is journaled with the event, so
 * replay hands the same value back.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate, testActor } from "@actor-kit/test";
import {
  checksumState,
  createLiveFacts,
  type DeliveryInfo,
  defineActor,
  foldEvents,
  link,
  liveStepFacts,
  message,
  step,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type InboxState = { seen: string[]; deliveries: Array<DeliveryInfo | null> };

const InboxContract = defineActor("inbox", {
  input: z.object({}),
  init: (): InboxState => ({ seen: [], deliveries: [] }),
  roles: { any: () => true },
  messages: {
    DELIVER: message(z.object({ text: z.string() }), (s: InboxState, { text }, ctx) => {
      const key = ctx.delivery?.idempotencyKey ?? text;
      if (s.seen.includes(key)) return s;
      return { seen: [...s.seen, key], deliveries: [...s.deliveries, ctx.delivery ?? null] };
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: InboxState) => ({ n: s.seen.length })) },
});

const CourierContract = defineActor("courier", {
  input: z.object({}),
  init: () => ({ sent: 0 }),
  roles: { any: () => true },
  links: { inbox: link(InboxContract, { onUpdate: <S>(s: S) => s }) },
  messages: {
    SEND: message(z.object({ to: z.string(), text: z.string() }), (s: { sent: number }, { to, text }, ctx) => {
      ctx.forward("inbox", to, { type: "DELIVER", text });
      return { sent: s.sent + 1 };
    }),
  },
  views: { any: view.shared(schema({ sent: uint32 }), (s: { sent: number }) => ({ sent: s.sent })) },
});

const delivery: DeliveryInfo = {
  actorType: "courier",
  actorId: "c-1",
  effectId: "2:0",
  idempotencyKey: "courier/c-1/2:0",
  attempt: 2,
};

const inboxDef = {
  roles: { any: () => true },
  messages: { any: { DELIVER: InboxContract.def.messages.DELIVER } },
};

describe("ctx.delivery in the step core", () => {
  it("a message cause with delivery gives the handler ctx.delivery and journals it", () => {
    const facts = liveStepFacts(createLiveFacts(), () => []);
    const cause = {
      type: "message" as const,
      name: "DELIVER",
      payload: { text: "hi" },
      role: "any",
      caller: "u",
      callerType: "user" as const,
      delivery,
    };
    const result = step(inboxDef, { seen: [], deliveries: [] }, cause, facts, {});
    expect(result.state).toEqual({ seen: ["courier/c-1/2:0"], deliveries: [delivery] });
    expect(result.event.facts).toEqual({ delivery });
  });

  it("without delivery the handler sees undefined and nothing is journaled for it", () => {
    const facts = liveStepFacts(createLiveFacts(), () => []);
    const cause = {
      type: "message" as const,
      name: "DELIVER",
      payload: { text: "hi" },
      role: "any",
      caller: "u",
      callerType: "user" as const,
    };
    const result = step(inboxDef, { seen: [], deliveries: [] }, cause, facts, {});
    expect(result.state).toEqual({ seen: ["hi"], deliveries: [null] });
    expect(result.event.facts).toStrictEqual({});
  });

  it("replay hands the journaled delivery back to the handler", async () => {
    const facts = liveStepFacts(createLiveFacts(), () => []);
    const cause = {
      type: "message" as const,
      name: "DELIVER",
      payload: { text: "hi" },
      role: "any",
      caller: "u",
      callerType: "user" as const,
      delivery,
    };
    const result = step(inboxDef, { seen: [], deliveries: [] }, cause, facts, {});
    const event = {
      ...result.event,
      seq: 2,
      codeVersion: 1,
      stateChecksum: checksumState({}, result.state),
      createdAt: 0,
    };
    const start = { seq: 1, point: { state: { seen: [], deliveries: [] }, timers: [] } };
    const points = await foldEvents(inboxDef, start, [event]);
    expect(points.get(2)?.state).toEqual(result.state);
  });
});

describe("simulate: forwards carry their effect to the target", () => {
  it("the target sees the forward's actor, effect id, idempotency key and try 1", async () => {
    const sim = simulate({ contracts: [InboxContract, CourierContract] });
    const inbox = await sim.spawn(InboxContract, "i-1", {});
    const courier = await sim.spawn(CourierContract, "c-1", {});
    courier.send("u", { type: "SEND", to: "i-1", text: "hi" });
    expect(inbox.state.deliveries).toEqual([
      { actorType: "courier", actorId: "c-1", effectId: "2:0", idempotencyKey: "courier/c-1/2:0", attempt: 1 },
    ]);
    await replayJournal(InboxContract, inbox.journal);
  });
});

describe("testActor: send with delivery", () => {
  it("passes opts.delivery to the handler as ctx.delivery", async () => {
    const t = testActor(InboxContract);
    const state = t.init({});
    const first = await t.send(state, "svc", { type: "DELIVER", text: "hi" }, { callerType: "service", delivery });
    const again = await t.send(
      first.state,
      "svc",
      { type: "DELIVER", text: "hi" },
      { callerType: "service", delivery },
    );
    expect(again.state).toEqual({ seen: ["courier/c-1/2:0"], deliveries: [delivery] });
  });
});
