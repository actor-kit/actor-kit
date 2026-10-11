/**
 * setup() for actors with states (ADR-017 §1), built inside the tests (not at module load) so a
 * broken setup() fails a test rather than only a file's import. Covers states whose runtime
 * declaration is missing (in() still builds them, with no local), states without messages when a
 * message is sent in the wrong phase, and goto() carrying no local.
 */
import { simulate } from "@actor-kit/test";
import { defineActor, goto, phasedState, setup } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type S = { n: number };
const base = { input: z.object({}), init: (): S => ({ n: 0 }), roles: { any: () => true }, views: {} };

describe("setup() with states", () => {
  it("hands back the declared events and states, and its helpers build a working actor", async () => {
    const events = { Moved: z.object({ n: z.number() }) };
    const states = { idle: {}, playing: { local: z.object({ moves: z.number() }) } };
    const kit = setup({ events, states });
    expect(kit.events).toBe(events);
    expect(kit.states).toBe(states);
    expect(kit.env).toBeUndefined();
    const idle = kit.in("idle");
    const playing = kit.in("playing");
    const Game = defineActor("game", {
      ...base,
      events: kit.events,
      initial: "idle",
      states: {
        idle: idle.state({
          messages: { START: idle.message(z.object({}), (s: S, _p, ctx) => ctx.goto("playing", s)) },
        }),
        playing: playing.state({
          enter: () => ({ moves: 0 }),
          messages: {
            MOVE: playing.message(z.object({}), (s: S, _p, ctx) => {
              ctx.emit("Moved", { n: s.n + 1 });
              return ctx.stay({ n: s.n + 1 }, { moves: ctx.local.moves + 1 });
            }),
          },
        }),
      },
    });
    const game = await simulate({ contracts: [Game] }).spawn(Game, "g", {});
    expect(game.send("u", { type: "START" })).toEqual({ ok: true });
    expect(game.send("u", { type: "MOVE" })).toEqual({ ok: true });
    expect(phasedState(game.state)).toEqual({
      shared: { n: 1 },
      phase: "playing",
      local: { moves: 1 },
      stateTimers: [],
    });
  });

  it("in() builds a state with no local for a phase the kit types but does not declare at runtime", async () => {
    // States given only as a type argument (no `states` object), and a state the object leaves out.
    type None = Record<never, never>;
    const typedOnly = setup<None, { a: None; b: None }>({ events: {} });
    const partial = setup<None, { a: None; b?: None }>({ events: {}, states: { a: {} } });
    for (const kit of [typedOnly, partial]) {
      const a = kit.in("a");
      const b = kit.in("b");
      const Two = defineActor("two", {
        ...base,
        initial: "a",
        states: {
          a: a.state({ messages: { GO: a.message(z.object({}), (s: S, _p, ctx) => ctx.goto("b", s)) } }),
          b: b.state({}),
        },
      });
      const two = await simulate({ contracts: [Two] }).spawn(Two, "t", {});
      expect(two.send("u", { type: "GO" })).toEqual({ ok: true });
      expect(phasedState(two.state)).toEqual({ shared: { n: 0 }, phase: "b", local: null, stateTimers: [] });
    }
  });

  it("a message of another state is wrong_state even when some states declare no messages", async () => {
    const kit = setup({ events: {}, states: { waiting: {}, done: {}, playing: {} } });
    const playing = kit.in("playing");
    const Game = defineActor("game", {
      ...base,
      initial: "waiting",
      states: {
        waiting: kit.in("waiting").state({}),
        done: kit.in("done").state({}),
        playing: playing.state({ messages: { MOVE: playing.message(z.object({}), (s: S) => s) } }),
      },
    });
    const game = await simulate({ contracts: [Game] }).spawn(Game, "g", {});
    expect(game.send("u", { type: "MOVE" })).toMatchObject({ ok: false, code: "wrong_state" });
    expect(game.send("u", { type: "NOPE" })).toMatchObject({ ok: false, code: "unknown_message" });
  });

  it("goto() carries no local: the target state's enter builds it", () => {
    expect(goto("b", { n: 1 }, { x: 1 })).toMatchObject({ kind: "goto", hasLocal: false });
    expect(goto("b", { n: 1 })).toMatchObject({ kind: "goto", hasLocal: false, value: undefined });
  });
});
