/**
 * simulate().spawnSync (Run Set Jimmy feedback): an actor whose init is synchronous and makes no init
 * links spawns without await, exactly as spawn() would (same journal, same handle).
 */
import { ActorKitError } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import { link, setup, stepInitSync } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { QuizContract } from "../../examples/quiz/quiz";

type S = { n: number };
const kit = setup({});
const Counter = kit.actor("counter", {
  input: z.object({ n: z.number() }),
  init: ({ n }): S => ({ n }),
  roles: { any: () => true },
  messages: { INC: kit.message(z.object({}), (s: S) => ({ n: s.n + 1 })) },
  views: { any: { fn: (s: S) => s } },
});

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("simulate().spawnSync", () => {
  it("spawns at once, typed like spawn, with the same journal", async () => {
    const sim = simulate({ contracts: [Counter] });
    const c = sim.spawnSync(Counter, "c", { n: 2 });
    expectTypeOf(c.state).toEqualTypeOf<S>();
    c.send("u", { type: "INC" });
    expect(c.state).toEqual({ n: 3 });
    const viaAsync = await simulate({ contracts: [Counter] }).spawn(Counter, "c", { n: 2 });
    viaAsync.send("u", { type: "INC" });
    expect(c.journal).toEqual(viaAsync.journal);
    await replayJournal(Counter, c.journal);
  });

  it("works for an actor with states and with branch()", () => {
    const sim = simulate({ contracts: [QuizContract] });
    const q = sim.spawnSync(QuizContract, "q", {});
    const copy = sim.branch();
    q.send("ann", { type: "JOIN" });
    expect(q.state.shared.players).toEqual(["ann"]);
    expect(copy.actor(QuizContract, "q").state.shared.players).toEqual([]);
  });

  it("refuses an async init, init links, bad input and a second spawn, each with its code", () => {
    const Async = kit.actor("async", {
      input: z.object({}),
      init: async (): Promise<S> => ({ n: 0 }),
      roles: { any: () => true },
      views: {},
    });
    const Linker = kit.actor("linker", {
      input: z.object({}),
      init: (_i: object, ctx: { link(name: string, id: string): Promise<unknown> }): S => {
        void ctx.link("src", "x");
        return { n: 0 };
      },
      roles: { any: () => true },
      links: { src: link(Counter, { onUpdate: (s: S) => s }) },
      views: {},
    });
    const sim = simulate({ contracts: [Counter] });
    expect(thrown(() => sim.spawnSync(Async, "a", {}))).toMatchObject({
      code: "async_handler",
      message: 'simulate: "async" has an async init: spawnSync needs a synchronous init. Use await sim.spawn().',
    });
    expect(thrown(() => sim.spawnSync(Linker, "l", {}))).toMatchObject({
      code: "link_unavailable",
      message:
        'simulate: "linker" links in init (link "src"): spawnSync cannot wait for the view. Use await sim.spawn().',
    });
    expect(thrown(() => Reflect.apply(sim.spawnSync, sim, [Counter, "c", { n: "x" }]))).toMatchObject({
      code: "invalid_input",
    });
    sim.spawnSync(Counter, "c", { n: 1 });
    expect(thrown(() => sim.spawnSync(Counter, "c", { n: 1 }))).toBeInstanceOf(ActorKitError);
    expect(thrown(() => sim.spawnSync(Counter, "c", { n: 1 }))).toMatchObject({ code: "already_spawned" });
  });
});

describe("simulate().spawnSync: edges", () => {
  it("a spawned actor has no links", () => {
    expect(simulate().spawnSync(Counter, "c", { n: 0 }).links).toEqual([]);
  });

  it("an async init that rejects is refused without an unhandled rejection", () => {
    const Failing = kit.actor("failing", {
      input: z.object({}),
      init: async (): Promise<S> => {
        throw new Error("no");
      },
      roles: { any: () => true },
      views: {},
    });
    expect(thrown(() => simulate().spawnSync(Failing, "f", {}))).toMatchObject({ code: "async_handler" });
  });

  it("stepInitSync without init is a definition error", () => {
    const facts = {
      ctx: { now: () => 0, id: () => "", random: () => 0 },
      unlinkTargets: () => [],
      recorded: () => ({}),
    };
    const io = { env: {}, link: async () => ({}), onAsync: () => new Error("async") };
    expect(thrown(() => stepInitSync({}, { input: {}, caller: null, callerType: null }, facts, io))).toMatchObject({
      code: "invalid_actor_definition",
      message: "This actor has no init: add init(input) to the definition.",
    });
  });
});
