/**
 * ADR-016 and ADR-017 together, under simulate() and replayJournal():
 * - a states actor declared with `setup({ events, states, env })` sees its parsed env fakes in
 *   `enter`, state messages, state timers and top-level messages, next to emit / local / stay / goto;
 * - `sim.events()` and `sim.published(queue)` work with env fakes; a published message's
 *   idempotencyKey is the effect's (`${actorType}/${actorId}/${effectId}`, ADR-016 §1);
 * - the determinism guards (ADR-016 §5) also cover `enter` and state timers (ADR-017 §1).
 */

import { NondeterminismError, replayJournal, simulate } from "@actor-kit/test";
import { defineActor, idempotencyKey, phasedState, queue, setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { total: number };

const kit = setup({
  events: { RoundStarted: z.object({ n: z.number() }), Scored: z.object({ points: z.number() }) },
  states: { idle: {}, round: { local: z.object({ n: z.number() }), input: z.object({ n: z.number() }) } },
  env: z.object({ BONUS: z.number(), GAME_EVENTS: queue() }),
});
const idle = kit.in("idle");
const round = kit.in("round");

const Game = defineActor("game", {
  input: z.object({}),
  init: (): S => ({ total: 0 }),
  env: kit.env,
  events: kit.events,
  publish: { queue: "GAME_EVENTS", events: ["Scored"] },
  roles: { any: () => true },
  initial: "idle",
  states: {
    idle: idle.state({
      messages: { GO: idle.message(z.object({}), (s: S, _p, ctx) => ctx.goto("round", s, { n: ctx.env.BONUS })) },
    }),
    round: round.state({
      enter: (_s: S, { n }, ctx) => {
        ctx.emit("RoundStarted", { n });
        ctx.schedule("end", { in: "10s", scope: "state" });
        return { n };
      },
      messages: {
        HIT: round.message(z.object({}), (s: S, _p, ctx) => {
          ctx.emit("Scored", { points: ctx.local.n });
          return ctx.stay({ total: s.total + ctx.local.n }, { n: ctx.local.n + ctx.env.BONUS });
        }),
      },
      timers: {
        end: round.timer(z.object({}).optional(), (s: S, _p, ctx) => {
          ctx.emit("Scored", { points: ctx.env.BONUS });
          return ctx.goto("idle", { total: s.total + ctx.env.BONUS });
        }),
      },
    }),
  },
  messages: {
    ADD: kit.message(z.object({}), (s: S, _p, ctx) => ({ total: s.total + ctx.env.BONUS })),
  },
  views: {},
});

const fakeQueue = { send: async () => undefined, sendBatch: async () => undefined };
const fakes = { game: { BONUS: 5, GAME_EVENTS: fakeQueue, UNDECLARED: "dropped" } };

describe("states + typed env + domain events + publish in simulate()", () => {
  it("handlers in every kind of state handler see the parsed env; events and published messages are collected", async () => {
    const sim = simulate({ contracts: [Game], env: fakes });
    const game = await sim.spawn(Game, "g1", {});

    game.send("u", { type: "GO" });
    expect(phasedState(game.state)).toMatchObject({ phase: ["round"], locals: [{ n: 5 }] });
    game.send("u", { type: "HIT" });
    game.send("u", { type: "ADD" });
    expect(phasedState(game.state)).toMatchObject({ shared: { total: 10 }, phase: ["round"], locals: [{ n: 10 }] });
    sim.advance("10s");
    expect(phasedState(game.state)).toMatchObject({ shared: { total: 15 }, phase: ["idle"], locals: [null] });

    expect(sim.events().map((e) => [e.name, e.payload])).toEqual([
      ["RoundStarted", { n: 5 }],
      ["Scored", { points: 5 }],
      ["Scored", { points: 5 }],
    ]);
    const published = sim.published("GAME_EVENTS");
    expect(published.map((m) => [m.name, m.payload])).toEqual([
      ["Scored", { points: 5 }],
      ["Scored", { points: 5 }],
    ]);
    for (const m of published) {
      expect(m.idempotencyKey).toBe(idempotencyKey("game", "g1", `${m.seq}:${m.index}`));
    }
    expect(new Set(published.map((m) => m.idempotencyKey)).size).toBe(2);

    await replayJournal(Game, game.journal, { env: fakes.game });
  });

  it("an env fake that does not parse is refused before any handler runs", async () => {
    const sim = simulate({ contracts: [Game], env: { game: { BONUS: "five", GAME_EVENTS: fakeQueue } } });
    await expect(sim.spawn(Game, "g2", {})).rejects.toThrow(/BONUS/);
  });
});

describe("determinism guards cover state handlers (ADR-016 §5 + ADR-017 §1)", () => {
  const det = setup({ events: {}, states: { a: {}, b: {} } });
  const a = det.in("a");
  const b = det.in("b");

  function actor(enter: () => null, onTimer: () => void) {
    return defineActor("det", {
      input: z.object({}),
      init: (): S => ({ total: 0 }),
      roles: { any: () => true },
      initial: "a",
      states: {
        a: a.state({
          messages: {
            GO: a.message(z.object({}), (s: S, _p, ctx) => {
              ctx.schedule("tick", { in: "1s", scope: "state" });
              return ctx.goto("b", s);
            }),
            ARM: a.message(z.object({}), (s: S, _p, ctx) => {
              ctx.schedule("tick", { in: "1s", scope: "state" });
              return s;
            }),
          },
          timers: {
            tick: a.timer(z.object({}).optional(), (s: S) => {
              onTimer();
              return s;
            }),
          },
        }),
        b: b.state({ enter }),
      },
      views: {},
    });
  }

  it("Date.now() in enter throws NondeterminismError", async () => {
    const Det = actor(
      () => {
        Date.now();
        return null;
      },
      () => undefined,
    );
    const sim = simulate({ contracts: [Det] });
    const x = await sim.spawn(Det, "x", {});
    expect(() => x.send("u", { type: "GO" })).toThrow(NondeterminismError);
  });

  it("Math.random() in a state timer throws NondeterminismError", async () => {
    const Det = actor(
      () => null,
      () => {
        Math.random();
      },
    );
    const sim = simulate({ contracts: [Det] });
    const x = await sim.spawn(Det, "x", {});
    x.send("u", { type: "ARM" });
    expect(() => sim.advance("1s")).toThrow(NondeterminismError);
  });

  it("the globals are back after a guarded state handler threw", async () => {
    const Det = actor(
      () => {
        crypto.randomUUID();
        return null;
      },
      () => undefined,
    );
    const sim = simulate({ contracts: [Det] });
    const x = await sim.spawn(Det, "x", {});
    expect(() => x.send("u", { type: "GO" })).toThrow(NondeterminismError);
    expect(typeof Date.now()).toBe("number");
    expect(typeof crypto.randomUUID()).toBe("string");
  });
});
