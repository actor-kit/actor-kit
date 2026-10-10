/**
 * States with typed locals (ADR-017 §1), on the quiz example (examples/quiz): lobby → round → reveal.
 * Persisted state is { shared, phase, local, stateTimers }; handlers return stay / goto / shared;
 * exit drops the local and cancels scope:"state" timers; messages are accepted only in the states
 * that declare them (plus top-level ones), else `wrong_state` before guards; views see the phase.
 */
import { replayJournal, simulate } from "@actor-kit/test";
import { defineActor, goto, phasedState, setup, stay } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CORRECT, QuizContract } from "../../examples/quiz/quiz";

async function quiz() {
  const sim = simulate({ contracts: [QuizContract], now: 0 });
  const q = await sim.spawn(QuizContract, "q1", {});
  q.send("ann", { type: "JOIN" });
  q.send("bob", { type: "JOIN" });
  return { sim, q };
}

describe("quiz: phases, locals and state timers", () => {
  it("starts in the initial state with no local", async () => {
    const { q } = await quiz();
    expect(q.state).toEqual({
      shared: { players: ["ann", "bob"], scores: { ann: 0, bob: 0 } },
      phase: "lobby",
      local: null,
      stateTimers: [],
    });
    expect(q.view("ann")).toEqual({ phase: "lobby", round: 0, players: 2, answered: 0 });
  });

  it("goto enters the round: enter builds the local, schedules a state timer and emits", async () => {
    const { sim, q } = await quiz();
    expect(q.send("ann", { type: "START" })).toEqual({ ok: true });
    expect(phasedState(q.state)).toMatchObject({
      phase: "round",
      local: { n: 1, answers: {} },
      stateTimers: ["round:roundEnd"],
    });
    expect(q.timers.map((t) => [t.name, t.key, t.fireAt])).toEqual([["roundEnd", "round:roundEnd", 30_000]]);
    expect(sim.events().map((e) => e.name)).toEqual(["RoundStarted"]);
  });

  it("stay updates the local; a plain return keeps it", async () => {
    const { q } = await quiz();
    q.send("ann", { type: "START" });
    q.send("ann", { type: "ANSWER", text: CORRECT });
    q.send("bob", { type: "ANSWER", text: "7" });
    q.send("cat", { type: "JOIN" }); // top-level, plain return: the local stays
    expect(phasedState(q.state).local).toEqual({ n: 1, answers: { ann: CORRECT, bob: "7" } });
    expect(q.view("ann")).toEqual({ phase: "round", round: 1, players: 3, answered: 2 });
  });

  it("the state timer ends the round: exit drops the local, the goto carries the scores", async () => {
    const { sim, q } = await quiz();
    q.send("ann", { type: "START" });
    q.send("ann", { type: "ANSWER", text: CORRECT });
    sim.advance("30s");
    expect(q.state).toEqual({
      shared: { players: ["ann", "bob"], scores: { ann: 1, bob: 0 } },
      phase: "reveal",
      local: null,
      stateTimers: [],
    });
    expect(sim.events().at(-1)).toMatchObject({ name: "RoundScored", payload: { n: 1, correct: ["ann"] } });
    await replayJournal(QuizContract, q.journal);
  });

  it("leaving the round early cancels its state timer", async () => {
    const { q } = await quiz();
    q.send("ann", { type: "START" });
    expect(q.send("host", { type: "END" }, { callerType: "service" })).toEqual({ ok: true });
    expect(phasedState(q.state).phase).toBe("reveal");
    expect(q.timers).toEqual([]);
    q.send("ann", { type: "NEXT" });
    expect(phasedState(q.state)).toMatchObject({ phase: "lobby", local: null });
    await replayJournal(QuizContract, q.journal);
  });

  it("a message declared only by other states is rejected with wrong_state, before its guard", async () => {
    const { q } = await quiz();
    expect(q.send("ann", { type: "ANSWER", text: "x" })).toEqual({ ok: false, error: "wrong_state" });
    expect(q.send("ann", { type: "END" })).toEqual({ ok: false, error: "wrong_state" });
    expect(q.send("ann", { type: "NOPE" })).toEqual({ ok: false, error: "message_not_found" });
    q.send("ann", { type: "START" });
    expect(q.send("ann", { type: "END" })).toEqual({ ok: false, error: "guard_failed" });
    expect(q.send("ann", { type: "START" })).toEqual({ ok: false, error: "wrong_state" });
  });
});

describe("runtime checks", () => {
  type S = { n: number };
  const kit = setup({ events: {}, states: { a: {}, b: { local: z.object({ k: z.number() }) } } });
  const a = kit.in("a");
  const b = kit.in("b");

  it("a local that does not parse fails the transition", async () => {
    const Bad = defineActor("bad", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      initial: "a",
      states: {
        a: a.state({ messages: { GO: a.message(z.object({}), (s: S, _p, ctx) => ctx.goto("b", s)) } }),
        b: b.state({
          enter: () => ({ k: 1 }),
          messages: {
            // Outside the typed helpers nothing stops a wrong local but the runtime check.
            BREAK: { schema: z.object({}), handler: (s: S) => stay(s, { k: "x" }) },
          },
        }),
      },
      views: {},
    });
    const sim = simulate({ contracts: [Bad] });
    const actor = await sim.spawn(Bad, "x", {});
    actor.send("u", { type: "GO" });
    expect(phasedState(actor.state).local).toEqual({ k: 1 });
    expect(() => actor.send("u", { type: "BREAK" })).toThrow(/State "b": invalid local/);
  });

  it("an initial state with a local, a missing initial or an undeclared goto target fail", async () => {
    const base = { input: z.object({}), init: (): S => ({ n: 0 }), roles: { any: () => true }, views: {} };
    const WithLocal = defineActor("with-local", { ...base, initial: "b", states: { a: a.state({}), b: b.state({}) } });
    await expect(simulate({ contracts: [WithLocal] }).spawn(WithLocal, "x", {})).rejects.toThrow(
      'The initial state "b" cannot have a local',
    );
    const NoInitial = defineActor("no-initial", { ...base, states: { a: a.state({}) } });
    await expect(simulate({ contracts: [NoInitial] }).spawn(NoInitial, "x", {})).rejects.toThrow("needs `initial`");
    const Lost = defineActor("lost", {
      ...base,
      initial: "a",
      states: { a: { messages: { GO: { schema: z.object({}), handler: (s: S) => goto("nowhere", s) } } } },
    });
    const lost = await simulate({ contracts: [Lost] }).spawn(Lost, "x", {});
    expect(() => lost.send("u", { type: "GO" })).toThrow('State "nowhere" is not declared');
  });

  it("stay() and goto() outside setup build transitions", () => {
    expect(stay({ n: 1 })).toMatchObject({ kind: "stay", hasLocal: false });
    expect(stay({ n: 1 }, { k: 2 })).toMatchObject({ kind: "stay", hasLocal: true, value: { k: 2 } });
    expect(goto("b", { n: 1 }, { x: 1 })).toMatchObject({ kind: "goto", phase: "b", value: { x: 1 } });
  });

  it("the persisted state of an actor with states must have its shape", () => {
    expect(() => phasedState({ n: 1 })).toThrow("must be { shared, phase, local, stateTimers }");
  });
});
