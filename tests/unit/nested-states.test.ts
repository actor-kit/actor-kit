/**
 * ADR-019 A: hierarchical states. One test per row of the transition table in
 * docs/adrs/019-hierarchical-states-and-history-at-scale.md ("A as built"), on the fixtures in
 * tests/integration/src/rounds.ts (a Run Set Jimmy-like round with `window` / `acting` children, and a
 * three-level tree whose root `initial` is a parent).
 */
import { replayJournal, simulate } from "@actor-kit/test";
import {
  admitStepMessage,
  defineActor,
  goto,
  localOf,
  matches,
  phasedState,
  setup,
  stay,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { upgradePhased } from "../../packages/worker/src/runtime/phases";
import { Deep, Rounds } from "../integration/src/rounds";

async function rounds() {
  const sim = simulate({ contracts: [Rounds], now: 0 });
  const r = await sim.spawn(Rounds, "r1", {});
  return { sim, r };
}

/** In the round's window: lobby → playing (round 1) → window. */
async function inWindow() {
  const { sim, r } = await rounds();
  expect(r.send("ann", { type: "START", round: 1 })).toEqual({ ok: true });
  return { sim, r };
}

function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error ? error.code : error;
  }
  return "did not throw";
}

const log = (state: unknown): unknown => {
  const shared = phasedState(state).shared;
  return typeof shared === "object" && shared !== null && "log" in shared ? shared.log : undefined;
};

describe("ADR-019 A transition table", () => {
  it("row 1: init enters the root initial and each initial child, without enter", async () => {
    const { r } = await rounds();
    expect(r.state).toEqual({ shared: { log: [] }, phase: ["lobby"], locals: [null], stateTimers: [[]] });
    const deep = await simulate({ contracts: [Deep] }).spawn(Deep, "d", {});
    expect(deep.state).toEqual({
      shared: { log: [] },
      phase: ["game", "setup"],
      locals: [null, null],
      stateTimers: [[], []],
    });
  });

  it("row 1: a local on the initial chain, or a parent without initial, fails init", async () => {
    type S = { n: number };
    const base = { input: z.object({}), init: (): S => ({ n: 0 }), roles: { any: () => true }, views: {} };
    const WithLocal = defineActor("with-local", {
      ...base,
      initial: "a",
      states: { a: { initial: "b", states: { b: { local: z.object({ k: z.number() }) } } } },
    });
    await expect(simulate({ contracts: [WithLocal] }).spawn(WithLocal, "x", {})).rejects.toThrow(
      'The initial state "a.b" cannot have a local',
    );
    const NoInitial = defineActor("no-initial", { ...base, initial: "a", states: { a: { states: { b: {} } } } });
    await expect(simulate({ contracts: [NoInitial] }).spawn(NoInitial, "x", {})).rejects.toThrow(
      'State "a" has child states and needs `initial`',
    );
  });

  it("row 2: a message is looked up innermost first, then top-level", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "END" }); // window's END, not playing's
    expect(phasedState(r.state).phase).toEqual(["playing", "window"]);
    expect(log(r.state)).toEqual(["exit lobby", "enter playing 1", "enter window 1", "window END"]);
    r.send("ann", { type: "ACT" });
    r.send("ann", { type: "END" }); // acting declares none: playing's END
    expect(phasedState(r.state).phase).toEqual(["over"]);
  });

  it("row 3: a message declared only off the active path is wrong_state, with dotted paths", async () => {
    const { r } = await rounds();
    expect(r.send("ann", { type: "BUY" })).toMatchObject({
      ok: false,
      code: "wrong_state",
      message: "BUY is accepted in playing.window; the actor is in lobby.",
      expected: ["playing.window"],
    });
    r.send("ann", { type: "START", round: 1 });
    expect(r.send("ann", { type: "DONE" })).toMatchObject({
      ok: false,
      code: "wrong_state",
      message: "DONE is accepted in playing.acting; the actor is in playing.window.",
    });
  });

  it("row 4: ctx.local is the merge of the locals up to the handler's level; ctx.phase is the path", async () => {
    const { sim, r } = await inWindow();
    r.send("ann", { type: "BUY" });
    expect(sim.events()).toEqual([expect.objectContaining({ name: "Bought", payload: { by: "ann", round: 1 } })]);
    expect(localOf(phasedState(r.state))).toEqual({ round: 1, buys: ["ann"] });
  });

  it("row 5: a plain shared return keeps every local and timer", async () => {
    const { r } = await inWindow();
    const before = phasedState(r.state);
    r.send("ann", { type: "END" });
    expect(phasedState(r.state)).toEqual({ ...before, shared: { log: [...log(before), "window END"] } });
  });

  it("row 6: stay(shared, local) at level k updates each level up to k from one merged value", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "BUY" });
    expect(phasedState(r.state).locals).toEqual([{ round: 1 }, { buys: ["ann"] }]);
    r.send("ann", { type: "BUMP" }); // playing's level: the window's local is untouched
    expect(phasedState(r.state).locals).toEqual([{ round: 11 }, { buys: ["ann"] }]);
  });

  it("row 7/12: goto into a parent from outside enters it with the input, then its initial child", async () => {
    const { r } = await inWindow();
    expect(r.state).toEqual({
      shared: { log: ["exit lobby", "enter playing 1", "enter window 1"] },
      phase: ["playing", "window"],
      locals: [{ round: 1 }, { buys: [] }],
      stateTimers: [["playing:tick"], ["playing.window:close"]],
    });
    expect(r.timers.map((t) => [t.name, t.key, t.fireAt])).toEqual([
      ["close", "playing.window:close", 5_000],
      ["tick", "playing:tick", 10_000],
    ]);
    const deep = await simulate({ contracts: [Deep] }).spawn(Deep, "d", {});
    deep.send("u", { type: "WAIT" });
    expect(deep.state).toMatchObject({ phase: ["game", "turn", "wait"], shared: { log: ["enter turn"] } });
  });

  it("row 8: goto a sibling exits the leaf and enters the target; the parent's local and timers survive", async () => {
    const { r } = await inWindow();
    r.send("bob", { type: "ACT" });
    expect(r.state).toEqual({
      shared: { log: ["exit lobby", "enter playing 1", "enter window 1", "exit window"] },
      phase: ["playing", "acting"],
      locals: [{ round: 1 }, { actor: "bob" }],
      stateTimers: [["playing:tick"], []],
    });
    expect(r.timers.map((t) => t.key)).toEqual(["playing:tick"]);
  });

  it("row 9/14: goto another branch exits innermost first, each exit cancelling its timers", async () => {
    const { r } = await inWindow();
    r.send("bob", { type: "ACT" });
    r.send("bob", { type: "END" });
    expect(r.state).toEqual({
      shared: {
        log: ["exit lobby", "enter playing 1", "enter window 1", "exit window", "exit acting bob", "exit playing 1"],
      },
      phase: ["over"],
      locals: [null],
      stateTimers: [[]],
    });
    expect(r.timers).toEqual([]);
  });

  it("row 10: goto the active leaf exits and re-enters it; the parent is kept", async () => {
    const { sim, r } = await inWindow();
    sim.advance("2s");
    r.send("ann", { type: "BUY" });
    r.send("ann", { type: "REOPEN" });
    expect(log(r.state)).toEqual(["exit lobby", "enter playing 1", "enter window 1", "exit window", "enter window 1"]);
    expect(phasedState(r.state).locals).toEqual([{ round: 1 }, { buys: [] }]);
    expect(r.timers.map((t) => [t.key, t.fireAt])).toEqual([
      ["playing.window:close", 7_000],
      ["playing:tick", 10_000],
    ]);
  });

  it("row 11: goto an active ancestor re-enters it with the input, then its initial child", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "NEXT_ROUND" });
    expect(r.state).toEqual({
      shared: {
        log: [
          "exit lobby",
          "enter playing 1",
          "enter window 1",
          "exit window",
          "exit playing 1",
          "enter playing 2",
          "enter window 2",
        ],
      },
      phase: ["playing", "window"],
      locals: [{ round: 2 }, { buys: [] }],
      stateTimers: [["playing:tick"], ["playing.window:close"]],
    });
  });

  it("row 13: the input goes to the target; a level entered on the way that declares input fails", async () => {
    const deep = await simulate({ contracts: [Deep] }).spawn(Deep, "d", {});
    deep.send("u", { type: "MOVE", x: 3 });
    expect(deep.state).toEqual({
      shared: { log: ["enter turn"] },
      phase: ["game", "turn", "move"],
      locals: [null, null, { x: 3 }],
      stateTimers: [[], [], []],
    });
    const { r } = await rounds();
    expect(codeOf(() => r.send("ann", { type: "JUMP" }))).toBe("missing_state_input");
  });

  it("row 14: exit cannot schedule a scope:state timer or goto", async () => {
    type S = { n: number };
    const kit = setup({ events: {}, states: { a: {}, b: {} } });
    const a = kit.in("a");
    const base = { input: z.object({}), init: (): S => ({ n: 0 }), roles: { any: () => true }, views: {} };
    const go = a.message(z.object({}), (s: S, _p, ctx) => ctx.goto("b", s));
    const Schedules = defineActor("schedules", {
      ...base,
      initial: "a",
      states: {
        a: {
          exit: (s: S, ctx: { schedule(name: string, options: object): void }) => {
            ctx.schedule("t", { in: 1, scope: "state" });
            return s;
          },
          messages: { GO: go },
        },
        b: {},
      },
      timers: { t: { schema: z.undefined(), handler: (s: S) => s } },
    });
    const one = await simulate({ contracts: [Schedules] }).spawn(Schedules, "x", {});
    expect(codeOf(() => one.send("u", { type: "GO" }))).toBe("invalid_schedule");
    const Gotos = defineActor("gotos", {
      ...base,
      initial: "a",
      states: { a: { exit: (s: S) => stay(s, { k: 1 }), messages: { GO: go } }, b: {} },
    });
    const two = await simulate({ contracts: [Gotos] }).spawn(Gotos, "x", {});
    expect(codeOf(() => two.send("u", { type: "GO" }))).toBe("invalid_transition");
  });

  it("row 15: enter returns the local, or stay(shared, local) to change the shared state; never goto", async () => {
    const { r } = await inWindow();
    expect(log(r.state)).toContain("enter playing 1");
    type S = { n: number };
    const kit = setup({ events: {}, states: { a: {}, b: {} } });
    const a = kit.in("a");
    const Redirect = defineActor("redirect", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      views: {},
      initial: "a",
      states: {
        a: { messages: { GO: a.message(z.object({}), (s: S, _p, ctx) => ctx.goto("b", s)) } },
        b: { enter: (s: S, _i: unknown, ctx: { goto(p: string, s: S): unknown }) => ctx.goto("a", s) },
      },
    });
    const x = await simulate({ contracts: [Redirect] }).spawn(Redirect, "x", {});
    expect(codeOf(() => x.send("u", { type: "GO" }))).toBe("invalid_transition");
  });

  it("row 16: a scope:state timer belongs to the scheduling level, found from it outward", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "RETICK" });
    expect(phasedState(r.state).stateTimers).toEqual([
      ["playing:tick"],
      ["playing.window:close", "playing.window:tick"],
    ]);
    r.send("ann", { type: "ACT" }); // window exits: both of its timers go, playing's stays
    expect(r.timers.map((t) => t.key)).toEqual(["playing:tick"]);
  });

  it("row 17: a firing timer is found along the active path and leaves its owner's list", async () => {
    const { sim, r } = await inWindow();
    sim.advance("5s"); // window's close: goto acting
    expect(phasedState(r.state)).toMatchObject({
      phase: ["playing", "acting"],
      locals: [{ round: 1 }, { actor: "timeout" }],
    });
    sim.advance("5s"); // playing's tick fires in acting, at playing's level
    expect(log(r.state)).toContain("tick 1");
    expect(phasedState(r.state).stateTimers).toEqual([[], []]);
    await replayJournal(Rounds, r.journal);
  });

  it("row 18: top-level messages keep the path, locals and timers", async () => {
    const { r } = await inWindow();
    const before = phasedState(r.state);
    r.send("ann", { type: "PING" });
    expect(phasedState(r.state)).toEqual({ ...before, shared: { log: [...log(before), "ping"] } });
  });

  it("row 19: goto an undeclared path fails", async () => {
    const { r } = await inWindow();
    expect(codeOf(() => r.send("ann", { type: "LOST" }))).toBe("undeclared_state");
  });

  it("row 20: two non-null locals that are not both objects cannot be merged", async () => {
    type S = { n: number };
    const kit = setup({
      events: {},
      states: { a: {}, p: { local: z.number(), states: { c: { local: z.object({ k: z.number() }) } } } },
    });
    const a = kit.in("a");
    const Go = defineActor("go-merge", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      views: {},
      initial: "a",
      states: {
        a: a.state({ messages: { GO: a.message(z.object({}), (s: S, _p, ctx) => ctx.goto("p", s)) } }),
        p: kit.in("p").state({
          initial: "c",
          enter: () => 5,
          states: {
            c: kit.in(["p", "c"]).state({
              enter: () => ({ k: 1 }),
              messages: {
                READ: kit.in(["p", "c"]).message(z.object({}), (s: S, _p, ctx) => {
                  void ctx.local;
                  return s;
                }),
              },
            }),
          },
        }),
      },
    });
    const go = await simulate({ contracts: [Go] }).spawn(Go, "x", {});
    expect(go.send("u", { type: "GO" })).toEqual({ ok: true });
    expect(codeOf(() => go.send("u", { type: "READ" }))).toBe("invalid_local");
  });

  it("the whole round replays from its journal", async () => {
    const { sim, r } = await inWindow();
    r.send("ann", { type: "BUY" });
    r.send("bob", { type: "ACT" });
    r.send("bob", { type: "DONE" });
    r.send("ann", { type: "RETICK" });
    sim.advance("12s");
    r.send("ann", { type: "NEXT_ROUND" });
    r.send("ann", { type: "BUMP" });
    r.send("ann", { type: "END" });
    r.send("ann", { type: "AGAIN" });
    await replayJournal(Rounds, r.journal);
  });
});

describe("persisted shape (ADR-019 A)", () => {
  it("reads the 0.2 flat shape as a one-element path", () => {
    expect(phasedState({ shared: { n: 1 }, phase: "round", local: { n: 2 }, stateTimers: ["round:t"] })).toEqual({
      shared: { n: 1 },
      phase: ["round"],
      locals: [{ n: 2 }],
      stateTimers: [["round:t"]],
    });
  });

  it("refuses a path whose locals or timers do not match it level for level", () => {
    expect(() => phasedState({ shared: {}, phase: ["a", "b"], locals: [null], stateTimers: [[], []] })).toThrow(
      "one local and one timer list per level",
    );
    expect(() => phasedState({ shared: {}, phase: [], locals: [], stateTimers: [] })).toThrow("must be");
  });
});

describe("matches() and localOf() for views and roles", () => {
  it("matches a path prefix, given as a name or a path", async () => {
    const { r } = await inWindow();
    const state = phasedState(r.state);
    expect(matches(state, "playing")).toBe(true);
    expect(matches(state, ["playing"])).toBe(true);
    expect(matches(state, ["playing", "window"])).toBe(true);
    expect(matches(state, ["playing", "acting"])).toBe(false);
    expect(matches(state, "lobby")).toBe(false);
    expect(matches(state, ["playing", "window", "deeper"])).toBe(false);
  });

  it("localOf is null when every level's local is null", () => {
    expect(localOf({ locals: [null, null] })).toBeNull();
  });

  it("localOf merges the active path's locals, null when there are none", async () => {
    const { r } = await rounds();
    expect(localOf(phasedState(r.state))).toBeNull();
    r.send("ann", { type: "START", round: 4 });
    expect(localOf(phasedState(r.state))).toEqual({ round: 4, buys: [] });
  });
});

describe("ADR-019 A edges", () => {
  type S = { n: number };
  const base = { input: z.object({}), init: (): S => ({ n: 0 }), roles: { any: () => true }, views: {} };
  const go = (target: string | string[]) => ({ schema: z.object({}), handler: (s: S) => goto(target, s) });

  function errorOf(run: () => unknown): { code: unknown; message: string } {
    try {
      run();
    } catch (error) {
      if (!(error instanceof Error)) throw new Error("not an Error");
      return { code: "code" in error ? error.code : undefined, message: error.message };
    }
    throw new Error("did not throw");
  }

  async function spawn(states: Record<string, unknown>, initial = "a") {
    const Actor = defineActor("edge", { ...base, initial, states });
    return simulate({ contracts: [Actor] }).spawn(Actor, "x", {});
  }

  it("stay(shared) with no local keeps every level's local", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "BUY" });
    r.send("ann", { type: "STAY" });
    expect(phasedState(r.state).locals).toEqual([{ round: 1 }, { buys: ["ann"] }]);
    expect(log(r.state)).toContain("stay");
  });

  it("a timer scheduled without scope belongs to no level and outlives it", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "PLAN" });
    expect(phasedState(r.state).stateTimers).toEqual([["playing:tick"], ["playing.window:close"]]);
    r.send("ann", { type: "ACT" });
    expect(r.timers.map((t) => t.key)).toEqual(["playing:tick", "plain"]);
  });

  it("a handler at a parent level schedules for, and reads the local of, that level only", async () => {
    const { r } = await inWindow();
    r.send("ann", { type: "TICK_AGAIN" });
    r.send("ann", { type: "PEEK" });
    expect(phasedState(r.state).stateTimers).toEqual([["playing:tick"], ["playing.window:close"]]);
    expect(r.timers.map((t) => [t.key, t.fireAt])).toEqual([
      ["playing:tick", 1_000],
      ["playing.window:close", 5_000],
    ]);
    expect(log(r.state)).toContain('{"round":1}');
  });

  it("a message bubbles past levels that declare no messages", async () => {
    const deep = await simulate({ contracts: [Deep] }).spawn(Deep, "d", {});
    deep.send("u", { type: "WAIT" });
    expect(deep.send("u", { type: "NOTE" })).toEqual({ ok: true });
    expect(deep.state).toMatchObject({ phase: ["game", "turn", "wait"], shared: { log: ["enter turn", "note"] } });
  });

  it("unknown_message lists what the active path accepts, innermost first", async () => {
    const { r } = await inWindow();
    expect(r.send("ann", { type: "NOPE" })).toMatchObject({
      code: "unknown_message",
      message: expect.stringContaining('in state "playing.window"'),
      expected: [
        "BUY",
        "ACT",
        "REOPEN",
        "STAY",
        "PLAN",
        "RETICK",
        "END",
        "NEXT_ROUND",
        "BUMP",
        "PEEK",
        "TICK_AGAIN",
        "LOST",
        "PING",
      ],
    });
  });

  it("names a missing state by the path up to it", async () => {
    const x = await spawn({ a: { messages: { DEEP: go(["a", "b", "c"]), UNDER: go(["a", "x"]), NONE: go([]) } } });
    expect(errorOf(() => x.send("u", { type: "DEEP" }))).toEqual({
      code: "undeclared_state",
      message: expect.stringMatching(/^State "a\.b" is not declared on this actor/),
    });
    expect(errorOf(() => x.send("u", { type: "UNDER" }))).toMatchObject({ code: "undeclared_state" });
    expect(errorOf(() => x.send("u", { type: "NONE" }))).toEqual({
      code: "undeclared_state",
      message: "A state path needs at least one name.",
    });
  });

  it("a parent without initial fails with missing_initial on goto too", async () => {
    const x = await spawn({ a: { messages: { GO: go("p") } }, p: { states: { c: {} } } });
    expect(errorOf(() => x.send("u", { type: "GO" }))).toEqual({
      code: "missing_initial",
      message: 'State "p" has child states and needs `initial`: add initial: "<child>" to it.',
    });
  });

  it("a level that declares input, entered on the way, says how to reach it", async () => {
    const { r } = await rounds();
    expect(errorOf(() => r.send("ann", { type: "JUMP" })).message).toBe(
      'State "playing" declares an enter input, so only a goto that targets it can enter it. Goto "playing" itself (the input goes to the target), or drop its input.',
    );
  });

  it("enter and exit refuse goto, stay (exit), scoped timers (exit) and promises, by name", async () => {
    const exitStays = await spawn({ a: { exit: (s: S) => stay(s), messages: { GO: go("b") } }, b: {} });
    expect(errorOf(() => exitStays.send("u", { type: "GO" })).message).toBe(
      'State "a": exit returns the next shared state; it cannot goto.',
    );
    const enterGoes = await spawn({
      a: { messages: { GO: go("b") } },
      b: { enter: (s: S, _i: unknown, ctx: { goto(p: string, s: S): unknown }) => ctx.goto("a", s) },
    });
    expect(errorOf(() => enterGoes.send("u", { type: "GO" })).message).toBe(
      'State "b": enter returns its local or ctx.stay(shared, local); it cannot goto.',
    );
    const exitSchedules = await spawn({
      a: {
        exit: (s: S, ctx: { schedule(name: string, options: object): void }) => {
          ctx.schedule("t", { in: 1, scope: "state" });
          return s;
        },
        messages: { GO: go("b") },
      },
      b: {},
    });
    expect(errorOf(() => exitSchedules.send("u", { type: "GO" })).message).toBe(
      'State "a": exit cannot schedule a scope: "state" timer, because its state is being left. Schedule it in the next state\'s enter.',
    );
    const asyncExit = await spawn({ a: { exit: async (s: S) => s, messages: { GO: go("b") } }, b: {} });
    expect(errorOf(() => asyncExit.send("u", { type: "GO" }))).toEqual({
      code: "async_handler",
      message: 'State "a": exit returned a Promise. Handlers must be synchronous.',
    });
    const asyncEnter = await spawn({ a: { messages: { GO: go("b") } }, b: { enter: async () => null } });
    expect(errorOf(() => asyncEnter.send("u", { type: "GO" })).message).toBe(
      'State "b": enter returned a Promise. Handlers must be synchronous.',
    );
    const asyncHandler = await spawn({ a: { messages: { GO: { schema: z.object({}), handler: async (s: S) => s } } } });
    expect(errorOf(() => asyncHandler.send("u", { type: "GO" }))).toEqual({
      code: "async_handler",
      message:
        'Message handler for "GO" returned a Promise. Handlers must be synchronous — use execute() for async side effects.',
    });
  });

  it("enter sees the path being entered as ctx.phase", async () => {
    const { r } = await rounds();
    r.send("ann", { type: "START", round: 3 });
    expect(log(r.state)).toContain("enter playing 3");
  });

  it("a stay that fails a level's schema names that level", async () => {
    const kit = setup({ events: {}, states: { a: {}, p: { local: z.object({ k: z.number() }), states: { c: {} } } } });
    const Bad = defineActor("bad-stay", {
      ...base,
      initial: "a",
      states: {
        a: { messages: { GO: kit.in("a").message(z.object({}), (s: S, _p, ctx) => ctx.goto("p", s)) } },
        p: kit.in("p").state({
          initial: "c",
          enter: () => ({ k: 1 }),
          states: { c: { messages: { BREAK: { schema: z.object({}), handler: (s: S) => stay(s, { k: "x" }) } } } },
        }),
      },
    });
    const x = await simulate({ contracts: [Bad] }).spawn(Bad, "x", {});
    x.send("u", { type: "GO" });
    expect(errorOf(() => x.send("u", { type: "BREAK" })).message).toMatch(/^State "p": invalid local/);
  });

  it("merging a non-object local says why", async () => {
    expect(errorOf(() => localOf({ locals: [1, { k: 1 }] })).message).toBe(
      "Nested states merge their locals, so each local on a path must be an object (declare it with z.object).",
    );
    expect(errorOf(() => localOf({ locals: [[1], { k: 1 }] })).code).toBe("invalid_local");
  });
});

describe("persisted shape: messages and the load upgrade", () => {
  it("names each issue of a state that has neither shape", () => {
    expect(() => phasedState({ shared: {}, phase: ["a"], locals: [null], stateTimers: [] })).toThrow(
      /\(a path, one local and one timer list per level\): one local and one timer list per level$/,
    );
    expect(() => phasedState({ shared: {}, phase: ["a"], locals: [null] })).toThrow(
      /: Invalid input: expected array, received undefined$/,
    );
    expect(() => phasedState({ shared: {}, phase: [7], locals: [null], stateTimers: [[]] })).toThrow(
      /: Invalid input: expected string, received number$/,
    );
    expect(() => phasedState({ shared: {}, phase: [7], locals: "x", stateTimers: [[]] })).toThrow(
      /: Invalid input: expected string, received number; Invalid input: expected array, received string$/,
    );
  });

  it("upgradePhased rewrites the 0.2 shape of an actor with states, and leaves everything else", () => {
    const states = { round: {} };
    const flat = { shared: { n: 1 }, phase: "round", local: null, stateTimers: [] };
    expect(upgradePhased({ states }, flat)).toEqual({
      shared: { n: 1 },
      phase: ["round"],
      locals: [null],
      stateTimers: [[]],
    });
    expect(upgradePhased({}, flat)).toBe(flat);
    const current = { shared: {}, phase: ["round"], locals: [null], stateTimers: [[]] };
    expect(upgradePhased({ states }, current)).toBe(current);
  });
});

describe("admission with states", () => {
  it("a role with no top-level messages gets message_not_found, not a crash", () => {
    const state = { shared: {}, phase: ["a"], locals: [null], stateTimers: [[]] };
    const admission = admitStepMessage(
      { messages: {}, states: { a: {} } },
      "viewer",
      state,
      { type: "X" },
      {
        caller: "u",
        callerType: "user",
        env: {},
      },
    );
    expect(admission).toEqual({ ok: false, error: "message_not_found" });
  });
});

describe("ctx.reenter in a tree (ADR-019 A with Run Set Jimmy feedback 4)", () => {
  it("re-enters the handler's own level: from a child's message, the child; from the parent's, the parent", async () => {
    type S = { log: string[] };
    const kit = setup({ states: { p: { states: { a: {} } } } });
    const p = kit.in("p");
    const a = kit.in(["p", "a"]);
    const add = (s: S, line: string): S => ({ log: [...s.log, line] });
    const Tree = kit.actor("tree", {
      input: z.object({}),
      init: (): S => ({ log: [] }),
      roles: { any: () => true },
      views: {},
      initial: "p",
      states: {
        p: p.state({
          initial: "a",
          enter: (s: S, _i, ctx) => ctx.stay(add(s, "enter p")),
          exit: (s: S) => add(s, "exit p"),
          messages: { AGAIN_P: p.message(z.object({}), (s: S, _p, ctx) => ctx.reenter(s)) },
          states: {
            a: a.state({
              enter: (s: S, _i, ctx) => ctx.stay(add(s, "enter a")),
              exit: (s: S) => add(s, "exit a"),
              messages: { AGAIN_A: a.message(z.object({}), (s: S, _p, ctx) => ctx.reenter(s)) },
            }),
          },
        }),
      },
    });
    const tree = await simulate({ contracts: [Tree] }).spawn(Tree, "t", {});
    tree.send("u", { type: "AGAIN_A" });
    tree.send("u", { type: "AGAIN_P" });
    expect(phasedState(tree.state).shared).toEqual({
      log: ["exit a", "enter a", "exit a", "exit p", "enter p", "enter a"],
    });
  });
});
