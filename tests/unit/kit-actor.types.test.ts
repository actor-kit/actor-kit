/**
 * ADR-018 A: one canonical shape, setup-first. `setup({ env?, events?, states?, services? })` returns
 * the kit; `kit.actor(name, { ... })` (or `defineActor(name, kit, { ... })`) defines the actor, taking
 * the kit's events, env and states. Kit helpers type ctx.env / emit / local / goto / stay with no
 * annotations; standalone message()/timer() are typed identically (their ctx.emit takes no event).
 * Checked by `pnpm typecheck:types` and run by Vitest.
 */
import type { ContractMessages } from "@actor-kit/core";
import { simulate, testActor } from "@actor-kit/test";
import { defineActor, message, queue, setup, timer } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type S = { total: number; log: string[] };

const kit = setup({
  env: z.object({ BONUS: z.number(), GAME_EVENTS: queue() }),
  events: { Scored: z.object({ points: z.number() }) },
  states: { idle: {}, round: { local: z.object({ n: z.number() }), input: z.object({ n: z.number() }) } },
});
const idle = kit.in("idle");
const round = kit.in("round");

const Game = kit.actor("game", {
  input: z.object({}),
  init: (): S => ({ total: 0, log: [] }),
  roles: { any: () => true },
  publish: { queue: "GAME_EVENTS", events: ["Scored"] },
  initial: "idle",
  messages: {
    NOTE: kit.message(z.object({ text: z.string() }), (s: S, { text }, ctx) => {
      expectTypeOf(ctx.env.BONUS).toEqualTypeOf<number>();
      return { ...s, log: [...s.log, text] };
    }),
  },
  states: {
    idle: idle.state({
      messages: { GO: idle.message(z.object({}), (s: S, _p, ctx) => ctx.goto("round", s, { n: ctx.env.BONUS })) },
    }),
    round: round.state({
      enter: (_s: S, { n }) => ({ n }),
      messages: {
        SCORE: round.message(z.object({}), (s: S, _p, ctx) => {
          ctx.emit("Scored", { points: ctx.local.n });
          return ctx.goto("idle", { ...s, total: s.total + ctx.local.n });
        }),
      },
    }),
  },
  lifecycle: {
    connect: (s: S, event, ctx) => {
      expectTypeOf(ctx.env.BONUS).toEqualTypeOf<number>();
      return { ...s, log: [...s.log, `hi ${event.caller}`] };
    },
  },
  views: { any: { fn: (s: { shared: S }) => ({ total: s.shared.total }) } },
});

describe("kit.actor", () => {
  it("takes the kit's events, env and states: the contract carries them", () => {
    expect(Game.name).toBe("game");
    expect(Game.def.events).toBe(kit.events);
    expect(Game.def.env).toBe(kit.env);
    expectTypeOf<ContractMessages<typeof Game>>().toEqualTypeOf<
      ({ type: "NOTE" } & { text: string }) | { type: "GO" } | { type: "SCORE" }
    >();
  });

  it("runs like any contract (simulate, testActor)", async () => {
    const env = { game: { BONUS: 3, GAME_EVENTS: { send: async () => {}, sendBatch: async () => {} } } };
    const sim = simulate({ contracts: [Game], env });
    const g = await sim.spawn(Game, "g", {});
    g.send("u", { type: "GO" });
    g.send("u", { type: "SCORE" });
    expect(g.state).toMatchObject({ phase: ["idle"], shared: { total: 3 } });
    expect(sim.published("GAME_EVENTS").map((m) => m.name)).toEqual(["Scored"]);

    const Plain = setup({
      states: { a: {}, b: { local: z.object({ n: z.number() }), input: z.object({ n: z.number() }) } },
    });
    const Small = Plain.actor("small", {
      input: z.object({}),
      init: () => ({}),
      roles: { any: () => true },
      initial: "a",
      states: {
        a: Plain.in("a").state({
          messages: { GO: Plain.in("a").message(z.object({}), (s: object, _p, ctx) => ctx.goto("b", s, { n: 3 })) },
        }),
        b: Plain.in("b").state({ enter: (_s: object, { n }) => ({ n }) }),
      },
      views: {},
    });
    const t = testActor(Small);
    const s1 = (await t.send(t.init({}), "u", { type: "GO" })).state;
    expect(s1).toMatchObject({ phase: ["b"], locals: [{ n: 3 }] });
  });

  it("defineActor(name, kit, def) is the same as kit.actor(name, def)", () => {
    const plain = setup({});
    const Counter = defineActor("counter", plain, {
      input: z.object({}),
      init: () => ({ n: 0 }),
      roles: { any: () => true },
      messages: { INC: plain.message(z.object({}), (s: { n: number }) => ({ n: s.n + 1 })) },
      views: {},
    });
    expect(Counter.name).toBe("counter");
    expectTypeOf<ContractMessages<typeof Counter>>().toEqualTypeOf<{ type: "INC" }>();
  });

  it("refuses definitions the kit contradicts", () => {
    const k = setup({ events: { A: z.object({}) }, states: { a: {}, b: {} } });
    const base = { input: z.object({}), init: () => ({}), roles: {}, views: {} };
    const both = { a: k.in("a").state({}), b: k.in("b").state({}) };
    const badInitial = { ...base, initial: "c", states: both };
    const missingState = { ...base, initial: "a", states: { a: both.a } };
    const ownEvents = { ...base, initial: "a", states: both, events: { B: z.object({}) } };
    const noStates = { ...base };
    // @ts-expect-error initial must be a declared state
    k.actor("bad-initial", badInitial);
    // @ts-expect-error every declared state needs its definition
    k.actor("missing-state", missingState);
    // @ts-expect-error events come from the kit
    k.actor("own-events", ownEvents);
    // @ts-expect-error a kit with states needs initial and states
    k.actor("no-states", noStates);
    expect(k.actor("ok", { ...base, initial: "a", states: both }).name).toBe("ok");
  });
});

describe("standalone message() and timer() are typed like the kit's", () => {
  it("ctx.emit takes no event (an actor without events has none to emit)", () => {
    message(z.object({}), (s: S, _p, ctx) => {
      // @ts-expect-error no events are declared
      ctx.emit("Scored", { points: 1 });
      return s;
    });
    timer(z.object({}), (s: S, _p, ctx) => {
      // @ts-expect-error no events are declared
      ctx.emit("Scored", { points: 1 });
      return s;
    });
    expect(true).toBe(true);
  });

  it("setup({}) with no events gives the same helpers", () => {
    const plain = setup({});
    plain.message(z.object({}), (s: S, _p, ctx) => {
      // @ts-expect-error no events are declared
      ctx.emit("Scored", { points: 1 });
      expectTypeOf(ctx.env).toEqualTypeOf<unknown>();
      return s;
    });
    expect(plain.events).toEqual({});
  });
});

describe("defineActor dispatch", () => {
  const def = { input: z.object({}), init: () => ({}), roles: {}, messages: {}, views: {} };

  it("with a kit, the kit defines the actor (its events and env join the definition)", () => {
    const kit = setup({ events: { E: z.object({}) } });
    const contract = defineActor("a", kit, def);
    expect(contract.def).toEqual({ ...def, events: kit.events, env: undefined });
    expect(contract.def.events).toBe(kit.events);
  });

  it("without a kit, the definition is the contract's, as it is", () => {
    expect(defineActor("a", def).def).toBe(def);
    const withActorField = { ...def, actor: "not a function" };
    expect(defineActor("a", withActorField).def).toBe(withActorField);
    expect(Reflect.apply(defineActor, undefined, ["a", null])).toEqual({ name: "a", def: null });
    expect(Reflect.apply(defineActor, undefined, ["a", "def"])).toEqual({ name: "a", def: "def" });
  });
});
