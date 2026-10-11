/**
 * The outbound event stream (ADR-017 §3): `publish: { queue, events }` turns each emitted event in
 * `publish.events` into an outbox row (effect id `seq:index`, retries, dead letters, redrive) that
 * the Durable Object sends to the Queue binding after commit. The body is
 * `{ actorType, actorId, seq, index, name, payload, at, causationId, correlationId, idempotencyKey }`,
 * idempotencyKey = `${actorType}/${actorId}/${effectId}`. simulate() collects them per queue.
 */
import { simulate } from "@actor-kit/test";
import { defineActor, PUBLISH_SERVICE, publishedMessages, resolvePublish, setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const events = { Placed: z.object({ n: z.number() }), Noted: z.object({}) };

describe("resolvePublish", () => {
  it("is null without publish", () => {
    expect(resolvePublish(undefined, events, {})).toBeNull();
  });

  it("validates the queue, the event names and the reserved service name", () => {
    expect(resolvePublish({ queue: "Q", events: ["Placed"] }, events, {})).toEqual({
      queue: "Q",
      events: new Set(["Placed"]),
    });
    expect(() => resolvePublish({ queue: "", events: ["Placed"] }, events, {})).toThrow("publish.queue");
    expect(() => resolvePublish({ queue: "Q", events: ["Nope"] }, events, {})).toThrow(
      'publish: event "Nope" is not declared in events',
    );
    expect(() => resolvePublish({ queue: "Q", events: ["Placed"] }, undefined, {})).toThrow('"Placed" is not declared');
    expect(() => resolvePublish({ queue: "Q", events: [] }, events, { [PUBLISH_SERVICE]: {} })).toThrow(
      `"${PUBLISH_SERVICE}" is reserved`,
    );
  });
});

describe("publishedMessages", () => {
  const config = { queue: "Q", events: new Set(["Placed"]) };
  it("one message per published event, with the effect id and idempotency key", () => {
    const messages = publishedMessages(
      config,
      [
        { name: "Placed", payload: { n: 1 }, index: 1 },
        { name: "Noted", payload: {}, index: 2 },
        { name: "Placed", payload: { n: 2 }, index: 3 },
      ],
      { actorType: "lot", actorId: "l1", seq: 7, at: 99, correlationId: "user/u/1", position: 4 },
    );
    expect(messages).toEqual([
      {
        effectId: "7:1",
        index: 1,
        body: {
          actorType: "lot",
          actorId: "l1",
          seq: 7,
          index: 1,
          name: "Placed",
          payload: { n: 1 },
          at: 99,
          causationId: "lot/l1/7",
          correlationId: "user/u/1",
          idempotencyKey: "lot/l1/7:1",
          position: 5,
        },
      },
      expect.objectContaining({
        effectId: "7:3",
        body: expect.objectContaining({ idempotencyKey: "lot/l1/7:3", position: 6 }),
      }),
    ]);
  });

  it("nothing when no emitted event is published", () => {
    expect(
      publishedMessages(config, [{ name: "Noted", payload: {}, index: 0 }], {
        actorType: "a",
        actorId: "b",
        seq: 1,
        at: 0,
        correlationId: "a/b/1",
        position: 0,
      }),
    ).toEqual([]);
  });
});

type S = { n: number };
const kit = setup({ events });
const Lot = defineActor("lot", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: { any: () => true },
  events: kit.events,
  publish: { queue: "LOT_EVENTS", events: ["Placed"] },
  messages: {
    PLACE: kit.message(z.object({ n: z.number() }), (s: S, { n }, ctx) => {
      ctx.execute("AUDIT", {});
      ctx.emit("Noted", {});
      ctx.emit("Placed", { n });
      return { n: s.n + n };
    }),
  },
  services: { AUDIT: { fn: async () => null } },
  views: {},
});

describe("simulate", () => {
  it("collects published messages per queue, with ids after the transition's other effects", async () => {
    const sim = simulate({ contracts: [Lot], now: 50 });
    const lot = await sim.spawn(Lot, "l1", {});
    lot.send("u", { type: "PLACE", n: 3 });
    expect(sim.published("LOT_EVENTS")).toEqual([
      {
        actorType: "lot",
        actorId: "l1",
        seq: 2,
        index: 2,
        name: "Placed",
        payload: { n: 3 },
        at: 50,
        causationId: "lot/l1/2",
        correlationId: "lot/l1/2",
        idempotencyKey: "lot/l1/2:2",
        position: 1,
      },
    ]);
    expect(sim.published("OTHER")).toEqual([]);
    // Publishing is not a service: nothing waits to be resolved but the audit.
    expect(sim.pendingEffects().map((p) => p.service)).toEqual(["AUDIT"]);
  });

  it("a branch keeps its own published messages", async () => {
    const sim = simulate({ contracts: [Lot] });
    const lot = await sim.spawn(Lot, "l1", {});
    const other = sim.branch();
    lot.send("u", { type: "PLACE", n: 1 });
    expect(sim.published("LOT_EVENTS")).toHaveLength(1);
    expect(other.published("LOT_EVENTS")).toHaveLength(0);
  });
});

describe("definition", () => {
  it("publishing an event that is not declared is refused when simulated or run", async () => {
    const Bad = defineActor("bad", {
      input: z.object({}),
      init: () => ({}),
      roles: { any: () => true },
      events,
      // @ts-expect-error not a declared event
      publish: { queue: "Q", events: ["Nope"] },
      views: {},
    });
    const sim = simulate({ contracts: [Bad] });
    await expect(sim.spawn(Bad, "b", {})).rejects.toThrow('publish: event "Nope" is not declared in events');
  });
});

describe("positions (ADR-019 E)", () => {
  it("number published events 1, 2, 3 per actor, skipping transitions that publish nothing", async () => {
    const Multi = defineActor("multi", {
      ...Lot.def,
      messages: {
        ...Lot.def.messages,
        TWICE: kit.message(z.object({}), (s: S, _p, ctx) => {
          ctx.emit("Placed", { n: 1 });
          ctx.emit("Placed", { n: 2 });
          return s;
        }),
        QUIET: kit.message(z.object({}), (s: S, _p, ctx) => {
          ctx.emit("Noted", {});
          return s;
        }),
      },
      services: Lot.def.services,
    });
    const sim = simulate({ contracts: [Multi], now: 0 });
    const a = await sim.spawn(Multi, "a", {});
    const b = await sim.spawn(Multi, "b", {});
    a.send("u", { type: "TWICE" });
    a.send("u", { type: "QUIET" });
    b.send("u", { type: "PLACE", n: 1 });
    a.send("u", { type: "PLACE", n: 5 });
    expect(sim.published("LOT_EVENTS").map((p) => [p.actorId, p.seq, p.position])).toEqual([
      ["a", 2, 1],
      ["a", 2, 2],
      ["b", 2, 1],
      ["a", 4, 3],
    ]);
  });
});
