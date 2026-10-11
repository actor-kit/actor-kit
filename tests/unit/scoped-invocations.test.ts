/**
 * ADR-019 B: scoped invocations. `ctx.execute(service, input, { scope: "state" })` belongs to the level
 * that called it: leaving that level cancels the call; a result that still arrives goes to the service's
 * `onStale` or is journaled as `service.stale` and ignored. Callbacks of a call run at the level that owns
 * it and may goto. On tests/integration/src/scoped-calls.ts, under simulate().
 */
import { replayJournal, simulate } from "@actor-kit/test";
import { defineActor, phasedState, setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScopedCalls } from "../integration/src/scoped-calls";

async function scoped() {
  const sim = simulate({ contracts: [ScopedCalls], now: 0 });
  const actor = await sim.spawn(ScopedCalls, "s1", {});
  return { sim, actor };
}

const log = (state: unknown): unknown => {
  const shared = phasedState(state).shared;
  return typeof shared === "object" && shared !== null && "log" in shared ? shared.log : undefined;
};

function errorOf(run: () => unknown): { code: unknown; message: string } {
  try {
    run();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("not an Error");
    return { code: "code" in error ? error.code : undefined, message: error.message };
  }
  throw new Error("did not throw");
}

describe("ADR-019 B: scoped invocations", () => {
  it("a scoped call belongs to the calling level: its effect id joins that level's list", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "LOAD", q: "x", ms: 10 });
    const ids = sim.pendingEffects().map((p) => p.effectId);
    expect(ids).toEqual(["2:0", "2:1"]);
    expect(phasedState(actor.state)).toMatchObject({ phase: ["loading"], stateTimers: [["2:0", "2:1"]] });
  });

  it("a result in time runs onDone at the owning level, may goto, and leaves the list", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "LOAD", q: "x", ms: 10 });
    sim.resolve("2:1", { ok: true }); // audit first: its id leaves loading's list
    expect(phasedState(actor.state).stateTimers).toEqual([["2:0"]]);
    sim.resolve("2:0", { answer: "42", aborted: false });
    expect(actor.state).toEqual({
      shared: { log: ["audited", "done 42 in loading"] },
      phase: ["ready"],
      locals: [{ answer: "42" }],
      stateTimers: [[]],
    });
    await replayJournal(ScopedCalls, actor.journal);
  });

  it("leaving the level cancels its calls; a late result goes to onStale, journaled as service.stale", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "LOAD", q: "x", ms: 10 });
    actor.send("u", { type: "CANCEL" });
    expect(sim.pendingEffects()).toEqual([]);
    expect(phasedState(actor.state)).toMatchObject({ phase: ["idle"], stateTimers: [[]] });
    sim.resolve("2:0", { answer: "late", aborted: true });
    expect(log(actor.state)).toEqual(["stale late aborted=true in idle"]);
    expect(sim.events().map((e) => [e.name, e.payload])).toEqual([["Stale", { effectId: "2:0" }]]);
    const last = actor.journal.events.at(-1);
    expect(last).toMatchObject({
      causeType: "service.stale",
      name: "lookup",
      payload: { input: { q: "x", ms: 10 }, result: { answer: "late", aborted: true }, effectId: "2:0" },
    });
    await replayJournal(ScopedCalls, actor.journal);
  });

  it("a late result of a service without onStale is journaled and ignored", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "LOAD", q: "x", ms: 10 });
    actor.send("u", { type: "CANCEL" });
    const before = actor.state;
    const seq = actor.journal.events.length;
    sim.resolve("2:1", { ok: true });
    expect(actor.state).toEqual(before);
    expect(actor.journal.events.slice(seq).map((e) => [e.causeType, e.name])).toEqual([["service.stale", "audit"]]);
    await replayJournal(ScopedCalls, actor.journal);
  });

  it("a late failure is dropped: no callback, no journal entry", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "LOAD", q: "x", ms: 10 });
    actor.send("u", { type: "CANCEL" });
    const seq = actor.journal.events.length;
    sim.reject("2:0", "too late");
    expect(actor.journal.events.length).toBe(seq);
    expect(() => sim.resolve("2:0", { answer: "x", aborted: false })).toThrow('No pending effect "2:0"');
  });

  it("a parent's call survives its children's changes and is cancelled when the parent exits", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "ROUND" });
    expect(phasedState(actor.state)).toMatchObject({ phase: ["round", "a"], stateTimers: [["2:0"], []] });
    actor.send("u", { type: "NEXT" });
    expect(sim.pendingEffects().map((p) => p.effectId)).toEqual(["2:0"]);
    actor.send("u", { type: "LEAVE" });
    expect(sim.pendingEffects()).toEqual([]);
  });

  it("an unscoped call is owned by no level: its result reaches onDone at the leaf", async () => {
    const { sim, actor } = await scoped();
    actor.send("u", { type: "FREE", q: "free" });
    expect(phasedState(actor.state).stateTimers).toEqual([[]]);
    sim.resolve("2:0", { answer: "free", aborted: false });
    expect(phasedState(actor.state)).toMatchObject({ phase: ["ready"], shared: { log: ["done free in idle"] } });
  });

  it("exit cannot make a scoped call; an actor without states cannot either", async () => {
    type S = { n: number };
    const base = { input: z.object({}), init: (): S => ({ n: 0 }), roles: { any: () => true }, views: {} };
    const kit = setup({ states: { a: {}, b: {} } });
    const service = { fn: async () => null };
    const Exits = defineActor("exits", {
      ...base,
      services: { s: service },
      initial: "a",
      states: {
        a: {
          exit: (s: S, ctx: { execute(name: string, input: unknown, options: object): string }) => {
            ctx.execute("s", {}, { scope: "state" });
            return s;
          },
          messages: { GO: kit.in("a").message(z.object({}), (s: S, _p, ctx) => ctx.goto("b", s)) },
        },
        b: {},
      },
    });
    const exits = await simulate({ contracts: [Exits] }).spawn(Exits, "x", {});
    expect(errorOf(() => exits.send("u", { type: "GO" }))).toEqual({
      code: "invalid_scope",
      message:
        'State "a": exit cannot make a scope: "state" call, because its state is being left. Make it in the next state\'s enter.',
    });
    const flat = setup({});
    const Flat = flat.actor("flat", {
      ...base,
      services: { s: service },
      messages: {
        GO: flat.message(z.object({}), (s: S, _p, ctx) => {
          ctx.execute("s", {}, { scope: "state" });
          return s;
        }),
      },
    });
    const one = await simulate({ contracts: [Flat] }).spawn(Flat, "x", {});
    expect(errorOf(() => one.send("u", { type: "GO" }))).toEqual({
      code: "invalid_scope",
      message:
        'ctx.execute("s", ..., { scope: "state" }) needs a state to belong to: call it from a state\'s message, timer or enter, in an actor with states.',
    });
  });
});
