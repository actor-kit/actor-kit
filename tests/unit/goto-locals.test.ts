/**
 * ADR-019 A rows 21-23 (Run Set Jimmy feedback 14): a transition that changes a kept level's local while
 * switching its child (`ctx.goto(target, shared, input, { locals })`, and `ctx.reenter`), and a child's
 * `enter` that updates its ancestors' locals through `ctx.stay(shared, mergedLocal)`. One test per row,
 * plus replay and restore, on tests/integration/src/round-locals.ts.
 */
import { replayJournal, simulate } from "@actor-kit/test";
import { goto, phasedState, planRestore, setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RoundLocals } from "../integration/src/round-locals";

async function playing() {
  const sim = simulate({ contracts: [RoundLocals], now: 0 });
  const r = await sim.spawn(RoundLocals, "r", {});
  expect(r.send("ann", { type: "START" })).toEqual({ ok: true });
  return { sim, r };
}

const at = (state: unknown) => {
  const { phase, locals, shared } = phasedState(state);
  return { phase, locals, shared };
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

describe("row 21: goto with { locals } changes a kept level's local as it switches the child", () => {
  it("updates playing's local and moves window → acting in one transition; exits and enters see the new local", async () => {
    const { r } = await playing();
    expect(r.send("ann", { type: "ACT" })).toEqual({ ok: true });
    expect(at(r.state)).toEqual({
      phase: ["playing", "acting"],
      locals: [{ round: 1, moves: 1, windows: 1 }, { actor: "ann" }],
      shared: {
        log: ["enter window moves 0 windows 0", "exit window moves 1 windows 1", "enter acting moves 1 windows 1"],
      },
    });
    r.send("ann", { type: "DONE" }); // acting → window, a move again
    expect(at(r.state).locals).toEqual([{ round: 1, moves: 2, windows: 2 }, { buys: [] }]);
  });

  it("without locals the kept level's local is kept (row 8 unchanged)", async () => {
    const { r } = await playing();
    r.send("ann", { type: "ACT" });
    r.send("ann", { type: "PASS" });
    expect(at(r.state).locals).toEqual([{ round: 1, moves: 1, windows: 2 }, { buys: [] }]);
  });

  it("from a parent's message, and through reenter (which keeps the levels above the handler's)", async () => {
    const { r } = await playing();
    r.send("ann", { type: "HUSH" });
    expect(at(r.state)).toMatchObject({ phase: ["playing", "quiet"], locals: [{ moves: 99 }, null] });
    const { r: r2 } = await playing();
    r2.send("ann", { type: "ACT" });
    r2.send("ann", { type: "AGAIN" });
    expect(at(r2.state)).toMatchObject({
      phase: ["playing", "acting"],
      locals: [{ round: 5, moves: 1, windows: 1 }, { actor: "ann" }],
    });
    expect(at(r2.state).shared.log.slice(-2)).toEqual([
      "exit acting moves 1 windows 1",
      "enter acting moves 1 windows 1",
    ]);
  });
});

describe("row 22: locals that name a level the goto does not keep, or one without a local, are refused", () => {
  it.each([
    ["WRONG_LEVEL", 'goto "playing.acting" keeps playing; its locals name "playing.window", which it does not keep.'],
    ["NOT_KEPT", 'goto "lobby" keeps no level; its locals name "playing", which it does not keep.'],
  ])("%s", async (type, message) => {
    const { r } = await playing();
    const before = r.state;
    expect(errorOf(() => r.send("ann", { type }))).toEqual({
      code: "invalid_goto_locals",
      message: `${message} Name only the levels kept by the goto (the common prefix of the active path and the target's parent), each with a local.`,
    });
    expect(r.state).toEqual(before);
  });

  it("a kept level that declares no local", async () => {
    type S = { n: number };
    const kit = setup({ states: { p: { states: { a: {}, b: {} } } } });
    const P = kit.actor("no-local", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      views: {},
      initial: "p",
      states: {
        p: kit.in("p").state({
          initial: "a",
          states: {
            a: kit.in(["p", "a"]).state({
              messages: {
                GO: kit
                  .in(["p", "a"])
                  .message(z.object({}), (s: S) => goto(["p", "b"], s, undefined, { locals: { p: {} } })),
              },
            }),
            b: kit.in(["p", "b"]).state({}),
          },
        }),
      },
    });
    const x = await simulate({ contracts: [P] }).spawn(P, "x", {});
    expect(errorOf(() => x.send("u", { type: "GO" }))).toEqual({
      code: "invalid_goto_locals",
      message:
        'goto "p.b" keeps p; its locals name "p", which declares no local. Name only the levels kept by the goto (the common prefix of the active path and the target\'s parent), each with a local.',
    });
  });

  it("malformed options, and a local that fails its level's schema", async () => {
    const { r } = await playing();
    expect(errorOf(() => r.send("ann", { type: "BAD_OPTIONS" }))).toEqual({
      code: "invalid_goto_locals",
      message:
        'goto\'s options are { locals?: { "<kept level>": local } }: Invalid input: expected record, received number; Unrecognized key: "local"',
    });
    expect(errorOf(() => r.send("ann", { type: "BAD_LOCAL" }))).toMatchObject({
      code: "invalid_local",
      message: expect.stringMatching(/^State "playing": invalid local/),
    });
  });
});

describe("row 23: a child's enter updates the levels above it through stay(shared, mergedLocal)", () => {
  it("the window's enter counts the round's windows in playing's local", async () => {
    const { r } = await playing();
    expect(at(r.state).locals).toEqual([{ round: 1, moves: 0, windows: 1 }, { buys: [] }]);
  });

  it("an enter that gives only its own keys leaves the levels above as they were", async () => {
    const { r } = await playing();
    r.send("bob", { type: "ACT" }); // acting's enter: stay(s, { actor })
    expect(at(r.state).locals).toEqual([{ round: 1, moves: 1, windows: 1 }, { actor: "bob" }]);
  });
});

describe("rows 21 and 23 three levels deep", () => {
  type S = { n: number };
  const kit = setup({
    states: {
      idle: {},
      g: {
        local: z.object({ a: z.number() }),
        input: z.object({ a: z.number() }),
        states: {
          p: {
            local: z.object({ b: z.number() }),
            states: { c: { local: z.object({ c: z.number() }) }, d: { local: z.object({ d: z.number() }) } },
          },
        },
      },
    },
  });
  const c = kit.in(["g", "p", "c"]);
  const d = kit.in(["g", "p", "d"]);
  const Deep = kit.actor("deep-locals", {
    input: z.object({}),
    init: (): S => ({ n: 0 }),
    roles: { any: () => true },
    views: {},
    initial: "idle",
    states: {
      idle: kit.in("idle").state({
        messages: { GO: kit.in("idle").message(z.object({}), (s: S, _p, ctx) => ctx.goto("g", s, { a: 1 })) },
      }),
      g: kit.in("g").state({
        initial: "p",
        enter: (_s: S, { a }) => ({ a }),
        states: {
          p: kit.in(["g", "p"]).state({
            initial: "c",
            enter: () => ({ b: 10 }),
            states: {
              // The grandchild's enter updates its parent and its grandparent.
              c: c.state({
                enter: (s: S, _i, ctx) => ctx.stay(s, { ...ctx.local, a: ctx.local.a + 1, b: ctx.local.b + 1, c: 0 }),
              }),
              d: d.state({
                enter: () => ({ d: 0 }),
                messages: {
                  BACK: d.message(z.object({}), (s: S, _p, ctx) =>
                    ctx.goto(["g", "p", "c"], s, undefined, { locals: { g: { a: 100 }, "g.p": { b: 200 } } }),
                  ),
                },
              }),
            },
          }),
        },
        messages: {
          START: kit.in("g").message(z.object({}), (s: S, _p, ctx) => ctx.goto(["g", "p", "d"], s, undefined, {})),
        },
      }),
    },
  });

  it("enter updates every level above it; goto updates every level it keeps", async () => {
    const sim = simulate({ contracts: [Deep] });
    const x = await sim.spawn(Deep, "x", {});
    expect(x.send("u", { type: "GO" })).toEqual({ ok: true });
    expect(at(x.state).locals).toEqual([{ a: 2 }, { b: 11 }, { c: 0 }]);
    x.send("u", { type: "START" });
    expect(at(x.state).locals).toEqual([{ a: 2 }, { b: 11 }, { d: 0 }]);
    x.send("u", { type: "BACK" });
    expect(at(x.state)).toMatchObject({ phase: ["g", "p", "c"], locals: [{ a: 101 }, { b: 201 }, { c: 0 }] });
    await replayJournal(Deep, x.journal);
  });
});

describe("rows 21-23 replay and restore", () => {
  async function game() {
    const { sim, r } = await playing();
    r.send("ann", { type: "BUY" });
    r.send("ann", { type: "ACT" });
    r.send("ann", { type: "DONE" });
    r.send("bob", { type: "ACT" });
    r.send("bob", { type: "AGAIN" });
    r.send("bob", { type: "DONE" });
    r.send("ann", { type: "RESTART" });
    r.send("ann", { type: "HUSH" });
    return { sim, r };
  }

  it("the journal replays to the same state", async () => {
    const { r } = await game();
    await replayJournal(RoundLocals, r.journal);
  });

  it("a restore to each seq gives the state the actor had there", async () => {
    const sim = simulate({ contracts: [RoundLocals], now: 0 });
    const r = await sim.spawn(RoundLocals, "r", {});
    const states: unknown[] = [r.state];
    for (const type of ["START", "BUY", "ACT", "DONE", "ACT", "AGAIN", "DONE", "RESTART", "HUSH"]) {
      r.send("ann", { type });
      states.push(r.state);
    }
    const seqs = r.journal.events.map((e) => e.seq);
    expect(seqs).toHaveLength(states.length);
    for (const [i, seq] of seqs.entries()) {
      expect((await planRestore(RoundLocals.def, r.journal, seq)).state).toEqual(states[i]);
    }
  });
});
