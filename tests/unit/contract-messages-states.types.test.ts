/**
 * ADR-018 B: `ContractMessages<T>` (the typed client `send`, refs, simulate) lists the top-level
 * messages and every state's messages. Checked by `pnpm typecheck:types`.
 */

import type { ContractMessages } from "@actor-kit/core";
import { defineActor, message, setup } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

type S = { players: string[] };

const kit = setup({
  events: {},
  states: { lobby: {}, round: { local: z.object({ n: z.number() }), input: z.object({ n: z.number() }) } },
});
const lobby = kit.in("lobby");
const round = kit.in("round");

const Game = defineActor("game", {
  input: z.object({}),
  init: (): S => ({ players: [] }),
  roles: { any: () => true },
  events: kit.events,
  initial: "lobby",
  messages: { JOIN: kit.message(z.object({}), (s: S) => s) },
  states: {
    lobby: lobby.state({
      messages: { START: lobby.message(z.object({}), (s: S, _p, ctx) => ctx.goto("round", s, { n: 1 })) },
    }),
    round: round.state({
      enter: (_s: S, { n }) => ({ n }),
      messages: {
        ANSWER: round.message(z.object({ text: z.string() }), (s: S) => s),
      },
      timers: { tick: round.timer(z.object({}), (s: S) => s) },
    }),
  },
  views: {},
});

const OnlyStates = defineActor("only-states", {
  input: z.object({}),
  init: (): S => ({ players: [] }),
  roles: { any: () => true },
  events: kit.events,
  initial: "lobby",
  states: {
    lobby: lobby.state({ messages: { GO: lobby.message(z.object({ fast: z.boolean() }), (s: S) => s) } }),
    round: round.state({ enter: (_s: S, { n }) => ({ n }) }),
  },
  views: {},
});

const Flat = defineActor("flat", {
  input: z.object({}),
  init: (): S => ({ players: [] }),
  roles: { any: () => true },
  messages: { ADD: message(z.object({ name: z.string() }), (s: S) => s) },
  views: {},
});

describe("ContractMessages with states", () => {
  it("includes top-level and every state's messages", () => {
    expectTypeOf<ContractMessages<typeof Game>>().toEqualTypeOf<
      { type: "JOIN" } | { type: "START" } | ({ type: "ANSWER" } & { text: string })
    >();
    expect(Game.name).toBe("game");
  });

  it("works for an actor whose messages are all in states", () => {
    expectTypeOf<ContractMessages<typeof OnlyStates>>().toEqualTypeOf<{ type: "GO" } & { fast: boolean }>();
    expect(OnlyStates.name).toBe("only-states");
  });

  it("refuses a state message's wrong payload and timer names", () => {
    const answer: ContractMessages<typeof Game> = { type: "ANSWER", text: "42" };
    // @ts-expect-error ANSWER needs text
    const bad: ContractMessages<typeof Game> = { type: "ANSWER" };
    // @ts-expect-error timers are not messages
    const timer: ContractMessages<typeof Game> = { type: "tick" };
    expect([answer, bad, timer]).toHaveLength(3);
  });

  it("is unchanged for an actor without states", () => {
    expectTypeOf<ContractMessages<typeof Flat>>().toEqualTypeOf<{ type: "ADD" } & { name: string }>();
    expect(Flat.name).toBe("flat");
  });
});
