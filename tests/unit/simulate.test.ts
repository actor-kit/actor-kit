/**
 * simulate() (ADR-015 D4): many actors on a virtual clock, effects as data, transitions run
 * through the same step core as the Durable Object, journals verifiable with replayJournal().
 */
import { schema, string, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import { defineActor, message, timer } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type Order = { item: string; status: string; ids: string[]; rolls: number[]; log: string[]; total: number };

const Store = defineActor("store", {
  input: z.object({ item: z.string() }),
  init: ({ item }: { item: string }, ctx: { now(): number }): Order => ({
    item,
    status: "new",
    ids: [],
    rolls: [],
    log: [`init@${ctx.now()}`],
    total: 0,
  }),
  roles: {
    clerk: (_s: Order, caller: string) => caller.startsWith("clerk"),
    customer: () => true,
  },
  messages: {
    CHARGE: message(z.object({ cents: z.number().int().positive() }), {
      guard: (s: Order, _p: { cents: number }, ctx: { role: string }) => ctx.role === "clerk" && s.status === "new",
      handler: (s: Order, { cents }, ctx) => {
        ctx.execute("PAY", { cents });
        ctx.execute("RECEIPT", { item: s.item });
        return { ...s, status: "charging" };
      },
    }),
    ROLL: message(z.object({}), (s: Order, _p, ctx) => ({
      ...s,
      ids: [...s.ids, ctx.id()],
      rolls: [...s.rolls, ctx.random()],
    })),
    REMIND: message(z.object({ inMs: z.number() }), (s: Order, { inMs }, ctx) => {
      ctx.schedule("remind", { in: inMs, key: "remind", payload: { n: s.log.length } });
      return s;
    }),
    REMIND_TWICE: message(z.object({}), (s: Order, _p, ctx) => {
      ctx.schedule("remind", { in: 2000, key: "b", payload: { n: 2 } });
      ctx.schedule("remind", { in: 1000, key: "a", payload: { n: 1 } });
      return s;
    }),
    TELL: message(z.object({ targetId: z.string(), note: z.string() }), (s: Order, { targetId, note }, ctx) => {
      ctx.forward("store", targetId, { type: "NOTE", note });
      return s;
    }),
    NOTE: message(z.object({ note: z.string() }), (s: Order, { note }, { caller }) => ({
      ...s,
      log: [...s.log, `note:${note}:from:${caller}`],
    })),
  },
  timers: {
    remind: timer(z.object({ n: z.number() }), (s: Order, { n }, ctx) => ({
      ...s,
      log: [...s.log, `remind:${n}@${ctx.now()}:late:${ctx.lateBy}`],
    })),
  },
  services: {
    PAY: {
      fn: async () => ({ ok: true }),
      onDone: (s: Order, result: unknown, input: unknown) => ({
        ...s,
        status: "paid",
        total: z.object({ cents: z.number() }).parse(input).cents,
        log: [...s.log, `paid:${JSON.stringify(result)}`],
      }),
      onError: (s: Order, error: { message: string }) => ({ ...s, status: "declined", log: [...s.log, error.message] }),
    },
    RECEIPT: { fn: async () => null },
  },
  lifecycle: {
    connect: (s: Order, e: { caller: string; callerConnections: number }) => ({
      ...s,
      log: [...s.log, `connect:${e.caller}:${e.callerConnections}`],
    }),
    disconnect: (s: Order, e: { caller: string; callerConnections: number }) => ({
      ...s,
      log: [...s.log, `disconnect:${e.caller}:${e.callerConnections}`],
    }),
  },
  views: {
    clerk: view.shared(schema({ item: string, total: uint32 }), (s: Order) => ({ item: s.item, total: s.total })),
    customer: view.shared(schema({ status: string }), (s: Order) => ({ status: s.status })),
  },
});

const contracts = [Store];

describe("simulate: spawn, send, view", () => {
  it("spawns an actor at the virtual time and sends it messages", async () => {
    const sim = simulate({ contracts, now: 1000 });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    expect(store.state).toMatchObject({ item: "lamp", status: "new", log: ["init@1000"] });
    expect(sim.send(Store, "s1", "clerk-1", { type: "CHARGE", cents: 500 })).toEqual({ ok: true });
    expect(sim.actor(Store, "s1").state.status).toBe("charging");
  });

  it("parses the input at spawn and refuses a second spawn of the same id", async () => {
    const sim = simulate({ contracts });
    await expect(sim.spawn(Store, "s1", { item: 3 })).rejects.toThrow(/Invalid input/);
    await sim.spawn(Store, "s1", { item: "lamp" });
    await expect(sim.spawn(Store, "s1", { item: "lamp" })).rejects.toThrow(/already spawned/);
  });

  it("rejects like the runtime: no role, unknown message, invalid payload, guard", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    expect(store.send("customer", { type: "CHARGE", cents: 5 })).toEqual({ ok: false, error: "guard_failed" });
    expect(store.send("clerk-1", { type: "CHARGE", cents: -1 })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(store.send("clerk-1", { type: "NOPE" })).toEqual({ ok: false, error: "message_not_found" });
    expect(store.state.status).toBe("new");
    expect(store.journal.events).toHaveLength(1);
  });

  it("an unknown actor is an error", () => {
    const sim = simulate({ contracts });
    expect(() => sim.actor(Store, "nope")).toThrow(/store\/nope has not been spawned/);
  });

  it("computes the caller's role and view", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    expect(store.role("clerk-1")).toBe("clerk");
    expect(store.view("clerk-1")).toEqual({ item: "lamp", total: 0 });
    expect(store.view("alice")).toEqual({ status: "new" });
  });
});

describe("simulate: effects as data", () => {
  it("services never run on their own: executions wait as pending effects with their effect ids", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("clerk-1", { type: "CHARGE", cents: 500 });
    expect(sim.pendingEffects()).toEqual([
      { actor: { type: "store", id: "s1" }, effectId: "2:0", service: "PAY", input: { cents: 500 } },
      { actor: { type: "store", id: "s1" }, effectId: "2:1", service: "RECEIPT", input: { item: "lamp" } },
    ]);
  });

  it("resolve runs onDone and removes the effect", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("clerk-1", { type: "CHARGE", cents: 500 });
    const [pay] = sim.pendingEffects();
    sim.resolve(pay ?? "", { receipt: 7 });
    expect(store.state).toMatchObject({ status: "paid", total: 500 });
    expect(sim.pendingEffects().map((e) => e.service)).toEqual(["RECEIPT"]);
    sim.resolve("2:1", null);
    expect(sim.pendingEffects()).toEqual([]);
  });

  it("reject runs onError with the message", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("clerk-1", { type: "CHARGE", cents: 500 });
    sim.reject("2:0", "card declined");
    expect(store.state).toMatchObject({ status: "declined" });
    expect(store.state.log.at(-1)).toBe("card declined");
  });

  it("resolving an unknown or already settled effect is an error", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("clerk-1", { type: "CHARGE", cents: 500 });
    sim.resolve("2:0", {});
    expect(() => sim.resolve("2:0", {})).toThrow(/No pending effect "2:0"/);
  });

  it("an effect id shared by two actors must be given as the effect itself", async () => {
    const sim = simulate({ contracts });
    for (const id of ["s1", "s2"]) {
      const store = await sim.spawn(Store, id, { item: id });
      store.send("clerk-1", { type: "CHARGE", cents: 100 });
    }
    expect(() => sim.resolve("2:0", {})).toThrow(/ambiguous/);
    const s2pay = sim.pendingEffects().find((e) => e.actor.id === "s2" && e.service === "PAY");
    sim.resolve(s2pay ?? "", {});
    expect(sim.actor(Store, "s2").state.status).toBe("paid");
    expect(sim.actor(Store, "s1").state.status).toBe("charging");
  });

  it("forwards are delivered to the target actor with the original caller", async () => {
    const sim = simulate({ contracts });
    const a = await sim.spawn(Store, "a", { item: "a" });
    const b = await sim.spawn(Store, "b", { item: "b" });
    a.send("alice", { type: "TELL", targetId: "b", note: "hi" });
    expect(b.state.log.at(-1)).toBe("note:hi:from:alice");
  });

  it("a forward to an actor that does not exist is recorded as failed", async () => {
    const sim = simulate({ contracts });
    const a = await sim.spawn(Store, "a", { item: "a" });
    a.send("alice", { type: "TELL", targetId: "ghost", note: "hi" });
    expect(sim.failedForwards()).toEqual([
      { from: { type: "store", id: "a" }, to: { type: "store", id: "ghost" }, message: { type: "NOTE", note: "hi" } },
    ]);
  });
});

describe("simulate: the virtual clock", () => {
  it("advance fires due timers in (fireAt, id) order on their own deadlines, never late", async () => {
    const sim = simulate({ contracts, now: 0 });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("alice", { type: "REMIND_TWICE" });
    expect(store.timers.map((t) => [t.key, t.fireAt])).toEqual([
      ["a", 1000],
      ["b", 2000],
    ]);
    sim.advance("1500ms");
    expect(store.state.log.slice(1)).toEqual(["remind:1@1000:late:0"]);
    expect(sim.now).toBe(1500);
    sim.advance(500);
    expect(store.state.log.slice(1)).toEqual(["remind:1@1000:late:0", "remind:2@2000:late:0"]);
    expect(store.timers).toEqual([]);
  });

  it("scheduling an existing key replaces the timer", async () => {
    const sim = simulate({ contracts, now: 0 });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("alice", { type: "REMIND", inMs: 1000 });
    store.send("alice", { type: "REMIND", inMs: 5000 });
    expect(store.timers.map((t) => t.fireAt)).toEqual([5000]);
    sim.advance("2s");
    expect(store.state.log).toHaveLength(1);
  });

  it("advance refuses a negative duration", () => {
    expect(() => simulate({ contracts }).advance(-1)).toThrow(/duration/);
  });
});

describe("simulate: determinism", () => {
  it("ctx.id() and ctx.random() are seeded: the same seed gives the same values", async () => {
    const run = async (seed: number) => {
      const sim = simulate({ contracts, seed });
      const store = await sim.spawn(Store, "s1", { item: "lamp" });
      store.send("alice", { type: "ROLL" });
      store.send("alice", { type: "ROLL" });
      return { ids: store.state.ids, rolls: store.state.rolls };
    };
    const first = await run(42);
    expect(await run(42)).toEqual(first);
    expect(await run(43)).not.toEqual(first);
    expect(first.ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const r of first.rolls) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it("every simulated actor's journal replays to its state", async () => {
    const sim = simulate({ contracts, seed: 7, now: 0 });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("alice", { type: "ROLL" });
    store.send("clerk-1", { type: "CHARGE", cents: 900 });
    sim.resolve("3:0", { ok: 1 });
    store.send("alice", { type: "REMIND", inMs: 10 });
    sim.advance(10);
    const connection = store.connect("bob");
    connection.disconnect();
    const { state } = await replayJournal(Store, store.journal);
    expect(state).toEqual(store.state);
    expect(store.journal.events.map((e) => e.causeType)).toEqual([
      "init",
      "message",
      "message",
      "service.onDone",
      "message",
      "timer",
      "lifecycle.connect",
      "lifecycle.disconnect",
    ]);
  });
});

describe("simulate: connections", () => {
  it("connect and disconnect run lifecycle with the caller's open connection count", async () => {
    const sim = simulate({ contracts });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    const tab1 = store.connect("bob");
    const tab2 = store.connect("bob");
    tab1.disconnect();
    tab2.disconnect();
    expect(store.state.log.slice(1)).toEqual([
      "connect:bob:1",
      "connect:bob:2",
      "disconnect:bob:1",
      "disconnect:bob:0",
    ]);
    expect(() => tab2.disconnect()).toThrow(/already closed/);
  });
});

describe("simulate: branch", () => {
  it("branches are independent copies: actors, pending effects, timers and the clock", async () => {
    const sim = simulate({ contracts, seed: 1, now: 0 });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    store.send("clerk-1", { type: "CHARGE", cents: 500 });
    store.send("alice", { type: "REMIND", inMs: 100 });

    const paid = sim.branch();
    const declined = sim.branch();
    paid.resolve("2:0", {});
    declined.reject("2:0", "nope");
    paid.advance(100);

    expect(paid.actor(Store, "s1").state.status).toBe("paid");
    expect(declined.actor(Store, "s1").state.status).toBe("declined");
    expect(store.state.status).toBe("charging");
    expect(sim.pendingEffects()).toHaveLength(2);
    expect(paid.actor(Store, "s1").timers).toEqual([]);
    expect(store.timers).toHaveLength(1);
    expect([sim.now, paid.now, declined.now]).toEqual([0, 100, 0]);
  });

  it("a branch continues the same random sequence as its parent would", async () => {
    const sim = simulate({ contracts, seed: 9 });
    const store = await sim.spawn(Store, "s1", { item: "lamp" });
    const copy = sim.branch();
    store.send("alice", { type: "ROLL" });
    copy.actor(Store, "s1").send("alice", { type: "ROLL" });
    expect(copy.actor(Store, "s1").state.rolls).toEqual(store.state.rolls);
  });
});
