/**
 * ADR-018 D: testActor() is a single-actor wrapper over the runtime's pure step() core, like
 * simulate(). It runs actors with states (phases, locals, enter, scoped timers), returns emitted
 * events and recorded timers, takes env fakes, refuses with typed codes, and checks timers and
 * events exactly as the runtime does.
 */
import { testActor } from "@actor-kit/test";
import { defineActor, link, localOf, matches, message, setup, timer } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { CORRECT, QuizContract } from "../../examples/quiz/quiz";

function refusal(run: () => unknown): { code: unknown; message: string } {
  try {
    run();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("not an Error");
    return { code: "code" in error ? error.code : undefined, message: error.message };
  }
  throw new Error("did not throw");
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("not an Error");
    return { code: "code" in error ? error.code : undefined, message: error.message };
  }
  throw new Error("did not throw");
}

describe("testActor over step(): states", () => {
  it("init starts in the initial state, typed as the persisted phased state", () => {
    const t = testActor(QuizContract);
    const s0 = t.init({});
    expect(s0).toEqual({ shared: { players: [], scores: {} }, phase: ["lobby"], locals: [null], stateTimers: [[]] });
    expectTypeOf(s0.phase).toEqualTypeOf<readonly ["lobby"] | readonly ["round"] | readonly ["reveal"]>();
  });

  it("goto runs enter: local built, scoped timer recorded, event emitted", async () => {
    const t = testActor(QuizContract);
    const joined = await t.send(t.init({}), "ann", { type: "JOIN" });
    const started = await t.send(joined.state, "ann", { type: "START" });
    expect(started.state).toMatchObject({
      phase: ["round"],
      locals: [{ n: 1, answers: {} }],
      stateTimers: [["round:roundEnd"]],
    });
    expect(started.schedules).toEqual([
      { timer: "roundEnd", options: { in: "30s", scope: "state", key: "round:roundEnd" } },
    ]);
    expect(started.emitted).toEqual([{ name: "RoundStarted", payload: { n: 1 } }]);
    if (matches(started.state, "round")) expectTypeOf(localOf(started.state).n).toEqualTypeOf<number>();
  });

  it("stay updates the local; leaving the phase cancels its scoped timers", async () => {
    const t = testActor(QuizContract);
    const s1 = (await t.send(t.init({}), "ann", { type: "START" })).state;
    const s2 = (await t.send(s1, "ann", { type: "ANSWER", text: CORRECT })).state;
    expect(s2).toMatchObject({ phase: ["round"], locals: [{ n: 1, answers: { ann: CORRECT } }] });
    const ended = await t.send(s2, "host", { type: "END" }, { callerType: "service" });
    expect(ended.state).toMatchObject({ phase: ["reveal"], locals: [null], stateTimers: [[]] });
    expect(ended.cancels).toEqual(["round:roundEnd"]);
    expect(ended.emitted).toEqual([{ name: "RoundScored", payload: { n: 1, correct: ["ann"] } }]);
  });

  it("views and roles see the phased state", async () => {
    const t = testActor(QuizContract);
    const s1 = (await t.send(t.init({}), "ann", { type: "START" })).state;
    expect(t.role(s1, "host", { callerType: "service" })).toBe("host");
    expect(t.view(s1, "ann")).toEqual({
      role: "player",
      data: { phase: "round", round: 1, players: 0, answered: 0 },
    });
  });

  it("a message of another state is refused with wrong_state, before its guard", async () => {
    const t = testActor(QuizContract);
    const error = await refusalOf(() => t.send(t.init({}), "ann", { type: "ANSWER", text: "1" }));
    expect(error.code).toBe("wrong_state");
    expect(error.message).toBe("ANSWER is accepted in round; the actor is in lobby.");
  });
});

describe("testActor over step(): refusals carry a code", () => {
  type S = { n: number };
  const Counter = defineActor("counter", {
    input: z.object({}),
    init: (): S => ({ n: 0 }),
    roles: { owner: (_s: S, caller: string) => caller === "owner", viewer: () => true },
    messages: {
      ADD: message(z.object({ by: z.number() }), {
        guard: (s: S) => s.n < 1,
        handler: (s: S, { by }) => ({ n: s.n + by }),
      }),
    },
    views: { owner: { fn: (s: S) => s }, viewer: { fn: (s: S) => s } },
  });

  it("guard_failed, invalid_payload and unknown_message", async () => {
    const t = testActor(Counter);
    expect((await refusalOf(() => t.send({ n: 1 }, "owner", { type: "ADD", by: 1 }))).code).toBe("guard_failed");
    // @ts-expect-error by must be a number
    const bad = await refusalOf(() => t.send({ n: 0 }, "owner", { type: "ADD", by: "1" }));
    expect(bad.code).toBe("invalid_payload");
    // @ts-expect-error not a message of this actor
    const unknown = await refusalOf(() => t.send({ n: 0 }, "owner", { type: "NOPE" }));
    expect(unknown.code).toBe("unknown_message");
  });

  it("no_role when no role matches", async () => {
    const Closed = defineActor("closed", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { owner: (_s: S, caller: string) => caller === "owner" },
      messages: { ADD: message(z.object({}), (s: S) => s) },
      views: { owner: { fn: (s: S) => s } },
    });
    const t = testActor(Closed);
    expect((await refusalOf(() => t.send({ n: 0 }, "stranger", { type: "ADD" }))).code).toBe("no_role");
    expect(refusal(() => t.view({ n: 0 }, "stranger")).code).toBe("no_role");
  });
});

describe("testActor over step(): timers and events are checked like the runtime", () => {
  type S = { n: number };
  const kit = setup({ events: { Ticked: z.object({ n: z.number() }) } });
  const Clock = defineActor("clock", {
    input: z.object({}),
    init: (): S => ({ n: 0 }),
    roles: { any: () => true },
    events: kit.events,
    messages: {
      PLAN: kit.message(z.object({}), (s: S, _p, ctx) => {
        ctx.schedule("tick", { in: "5s", key: "t", payload: { n: 1 } });
        ctx.emit("Ticked", { n: 1 });
        return s;
      }),
      BAD_TIMER: message(z.object({}), (s: S, _p, ctx) => {
        ctx.schedule("nope", { in: "5s" });
        return s;
      }),
      BAD_PAYLOAD: message(z.object({}), (s: S, _p, ctx) => {
        ctx.schedule("tick", { in: "5s", payload: { n: "x" } });
        return s;
      }),
    },
    timers: { tick: timer(z.object({ n: z.number() }), (s: S, { n }) => ({ n: s.n + n })) },
    views: { any: { fn: (s: S) => s } },
  });

  it("records a declared timer with its options", async () => {
    const result = await testActor(Clock).send({ n: 0 }, "u", { type: "PLAN" });
    expect(result.schedules).toEqual([{ timer: "tick", options: { in: "5s", key: "t", payload: { n: 1 } } }]);
    expect(result.emitted).toEqual([{ name: "Ticked", payload: { n: 1 } }]);
  });

  it("refuses an undeclared timer and an invalid timer payload, as the runtime does", async () => {
    const t = testActor(Clock);
    expect((await refusalOf(() => t.send({ n: 0 }, "u", { type: "BAD_TIMER" }))).message).toContain('"nope"');
    expect((await refusalOf(() => t.send({ n: 0 }, "u", { type: "BAD_PAYLOAD" }))).message).toContain('"tick"');
  });
});

describe("testActor over step(): links", () => {
  type S = { unlinked: string[] };
  const Room = defineActor("room", {
    input: z.object({}),
    init: () => ({}),
    roles: { any: () => true },
    messages: {},
    views: {},
  });
  const Lobby = defineActor("lobby", {
    input: z.object({}),
    init: (): S => ({ unlinked: [] }),
    roles: { any: () => true },
    links: {
      room: link(Room, {
        onUpdate: (s: S) => s,
        onUnlink: (s: S, id) => ({ unlinked: [...s.unlinked, String(id)] }),
      }),
    },
    messages: {
      SWAP: message(z.object({}), (s: S, _p, ctx) => {
        ctx.link("room", "a");
        ctx.unlink("room");
        return s;
      }),
    },
    views: { any: { fn: (s: S) => s } },
  });

  it("unlink(name) runs onUnlink for the links made in the same transition (none are stored)", async () => {
    const result = await testActor(Lobby).send({ unlinked: [] }, "u", { type: "SWAP" });
    expect(result.state).toEqual({ unlinked: ["a"] });
    expect(result.unlinks).toEqual([{ name: "room", id: undefined }]);
  });
});
