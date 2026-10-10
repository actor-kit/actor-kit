/**
 * ADR-016 §4 + ADR-017: `setup({ events, states, env })` types ctx.env in every helper (top-level
 * and state messages, timers, enter) next to the typed emit, local, stay and goto. Checked by
 * `pnpm typecheck:types`.
 */

import { defineActor, queue, setup } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type S = { total: number };

const kit = setup({
  events: { Scored: z.object({ points: z.number() }) },
  states: { idle: {}, round: { local: z.object({ n: z.number() }), input: z.object({ n: z.number() }) } },
  env: z.object({ BONUS: z.number(), GAME_EVENTS: queue() }),
});
const idle = kit.in("idle");
const round = kit.in("round");

describe("setup({ env })", () => {
  it("every helper's ctx has the typed env beside emit / local / stay / goto", () => {
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
          messages: {
            GO: idle.message(z.object({}), (s: S, _p, ctx) => {
              expectTypeOf(ctx.env.BONUS).toEqualTypeOf<number>();
              return ctx.goto("round", s, { n: ctx.env.BONUS });
            }),
          },
        }),
        round: round.state({
          enter: (_s: S, { n }, ctx) => {
            expectTypeOf(ctx.env.BONUS).toEqualTypeOf<number>();
            expectTypeOf(ctx.env.GAME_EVENTS).toEqualTypeOf<Queue<unknown>>();
            ctx.emit("Scored", { points: n });
            return { n };
          },
          messages: {
            HIT: round.message(z.object({}), (s: S, _p, ctx) => {
              expectTypeOf(ctx.local).toEqualTypeOf<{ n: number }>();
              return ctx.stay({ total: s.total + ctx.env.BONUS }, { n: ctx.local.n + 1 });
            }),
          },
          timers: {
            end: round.timer(z.object({}), (s: S, _p, ctx) => {
              expectTypeOf(ctx.env.BONUS).toEqualTypeOf<number>();
              return ctx.goto("idle", s);
            }),
          },
        }),
      },
      messages: {
        ADD: kit.message(z.object({}), (s: S, _p, ctx) => {
          expectTypeOf(ctx.env.BONUS).toEqualTypeOf<number>();
          ctx.emit("Scored", { points: ctx.env.BONUS });
          return { total: s.total + ctx.env.BONUS };
        }),
      },
      views: {},
    });
    expect(Game.name).toBe("game");
  });

  it("env: kit.env types the actor's services and checks publish.queue like a literal schema", () => {
    defineActor("game-services", {
      input: z.object({}),
      init: (): S => ({ total: 0 }),
      env: kit.env,
      events: kit.events,
      publish: { queue: "GAME_EVENTS", events: ["Scored"] },
      roles: { any: () => true },
      services: {
        award: {
          fn: async (_input, env) => {
            expectTypeOf(env.BONUS).toEqualTypeOf<number>();
            return null;
          },
        },
      },
      views: {},
    });
    defineActor("game-bad-queue", {
      input: z.object({}),
      init: (): S => ({ total: 0 }),
      env: kit.env,
      events: kit.events,
      // @ts-expect-error "OTHER" is not a binding in env
      publish: { queue: "OTHER", events: ["Scored"] },
      roles: { any: () => true },
      views: {},
    });
  });

  it("reading a binding the env schema does not declare is a type error", () => {
    kit.message(z.object({}), (s: S, _p, ctx) => {
      // @ts-expect-error OTHER is not in the env schema
      return { total: s.total + ctx.env.OTHER };
    });
  });

  it("without env, ctx.env stays unknown", () => {
    const plain = setup({ events: {} });
    expect(plain.env).toBeUndefined();
    plain.message(z.object({}), (s: S, _p, ctx) => {
      expectTypeOf(ctx.env).toEqualTypeOf<unknown>();
      return s;
    });
  });
});
