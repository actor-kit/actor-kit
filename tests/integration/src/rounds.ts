/**
 * A nested-states actor for ADR-019 A (shared by the unit and integration tests), shaped like Run Set Jimmy's room: a round (`playing`) keeps
 * its local while its children (`window`, `acting`) come and go. `enter` and `exit` write to
 * `shared.log`, so tests can read the order levels were left and entered in.
 */
import { goto, setup } from "@actor-kit/worker/testing";
import { z } from "zod";

export type Shared = { log: string[] };

export const note = (s: Shared, line: string): Shared => ({ log: [...s.log, line] });

export const rounds = setup({
  events: { Bought: z.object({ by: z.string(), round: z.number() }) },
  states: {
    lobby: {},
    playing: {
      local: z.object({ round: z.number() }),
      input: z.object({ round: z.number() }),
      states: {
        window: { local: z.object({ buys: z.array(z.string()) }) },
        acting: { local: z.object({ actor: z.string() }), input: z.object({ actor: z.string() }) },
      },
    },
    over: {},
  },
});

const lobby = rounds.in("lobby");
const playing = rounds.in("playing");
const window = rounds.in(["playing", "window"]);
const acting = rounds.in(["playing", "acting"]);
const over = rounds.in("over");

export const Rounds = rounds.actor("rounds", {
  input: z.object({}),
  init: (): Shared => ({ log: [] }),
  roles: { any: () => true },
  initial: "lobby",
  messages: {
    PING: rounds.message(z.object({}), (s: Shared) => note(s, "ping")),
  },
  states: {
    lobby: lobby.state({
      exit: (s: Shared) => note(s, "exit lobby"),
      messages: {
        START: lobby.message(z.object({ round: z.number() }), (s: Shared, { round }, ctx) =>
          ctx.goto("playing", s, { round }),
        ),
        // playing declares an input, so it cannot be entered on the way to acting (row 13).
        JUMP: lobby.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto(["playing", "acting"], s, { actor: "x" })),
      },
    }),
    playing: playing.state({
      initial: "window",
      enter: (s: Shared, { round }, ctx) => {
        ctx.schedule("tick", { in: "10s", scope: "state" });
        return ctx.stay(note(s, `enter ${ctx.phase.join(".")} ${round}`), { round });
      },
      exit: (s: Shared, ctx) => note(s, `exit playing ${ctx.local.round}`),
      messages: {
        NEXT_ROUND: playing.message(z.object({}), (s: Shared, _p, ctx) =>
          ctx.goto("playing", s, { round: ctx.local.round + 1 }),
        ),
        END: playing.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("over", s)),
        // The guard sees playing's local only (not the window's), as the handler does.
        BUMP: playing.message(z.object({}), {
          guard: (_s: Shared, _p, ctx) => Object.keys(ctx.local).length === 1,
          handler: (s: Shared, _p, ctx) => ctx.stay(s, { round: ctx.local.round + 10 }),
        }),
        PEEK: playing.message(z.object({}), (s: Shared, _p, ctx) => note(s, JSON.stringify(ctx.local))),
        // A scoped timer from playing's level belongs to playing, whatever child is active.
        TICK_AGAIN: playing.message(z.object({}), (s: Shared, _p, ctx) => {
          ctx.schedule("tick", { in: "1s", scope: "state" });
          return s;
        }),
        // The typed ctx.goto refuses an undeclared path; the untyped goto() reaches the runtime check (row 19).
        LOST: playing.message(z.object({}), (s: Shared) => goto(["playing", "nope"], s)),
      },
      timers: {
        tick: playing.timer(z.undefined(), (s: Shared, _p, ctx) => note(s, `tick ${ctx.local.round}`)),
      },
      states: {
        window: window.state({
          enter: (s: Shared, _input, ctx) => {
            ctx.schedule("close", { in: "5s", scope: "state" });
            return ctx.stay(note(s, `enter window ${ctx.local.round}`), { buys: [] });
          },
          exit: (s: Shared) => note(s, "exit window"),
          messages: {
            BUY: window.message(z.object({}), (s: Shared, _p, ctx) => {
              ctx.emit("Bought", { by: ctx.caller, round: ctx.local.round });
              return ctx.stay(s, { round: ctx.local.round, buys: [...ctx.local.buys, ctx.caller] });
            }),
            ACT: window.message(z.object({}), (s: Shared, _p, ctx) =>
              ctx.goto(["playing", "acting"], s, { actor: ctx.caller }),
            ),
            REOPEN: window.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto(["playing", "window"], s)),
            STAY: window.message(z.object({}), (s: Shared, _p, ctx) => ctx.stay(note(s, "stay"))),
            // Not scoped: no level owns it, leaving the window keeps it.
            PLAN: window.message(z.object({}), (s: Shared, _p, ctx) => {
              ctx.schedule("close", { in: "1m", key: "plain" });
              return s;
            }),
            RETICK: window.message(z.object({}), (s: Shared, _p, ctx) => {
              ctx.schedule("tick", { in: "1s", scope: "state" });
              return s;
            }),
            // Same name as the parent's: the innermost declaration wins (row 2).
            END: window.message(z.object({}), (s: Shared) => note(s, "window END")),
          },
          timers: {
            close: window.timer(z.undefined(), (s: Shared, _p, ctx) =>
              ctx.goto(["playing", "acting"], s, { actor: "timeout" }),
            ),
          },
        }),
        acting: acting.state({
          enter: (_s: Shared, { actor }) => ({ actor }),
          exit: (s: Shared, ctx) => note(s, `exit acting ${ctx.local.actor}`),
          messages: {
            DONE: acting.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto(["playing", "window"], s)),
            BACK: acting.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("playing", s, { round: 7 })),
          },
        }),
      },
    }),
    over: over.state({
      messages: {
        AGAIN: over.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("lobby", s)),
      },
    }),
  },
  views: {},
});

/** A tree whose root `initial` is a parent, and whose deep levels declare no input on the way. */
export const deep = setup({
  events: {},
  states: {
    game: {
      states: {
        setup: {},
        turn: {
          states: {
            move: { local: z.object({ x: z.number() }), input: z.object({ x: z.number() }) },
            wait: {},
          },
        },
      },
    },
    done: {},
  },
});

const gameSetup = deep.in(["game", "setup"]);
const move = deep.in(["game", "turn", "move"]);

export const Deep = deep.actor("deep", {
  input: z.object({}),
  init: (): Shared => ({ log: [] }),
  roles: { any: () => true },
  initial: "game",
  messages: { NOTE: deep.message(z.object({}), (s: Shared) => note(s, "note")) },
  states: {
    game: deep.in("game").state({
      initial: "setup",
      states: {
        setup: gameSetup.state({
          messages: {
            MOVE: gameSetup.message(z.object({ x: z.number() }), (s: Shared, { x }, ctx) =>
              ctx.goto(["game", "turn", "move"], s, { x }),
            ),
            WAIT: gameSetup.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto(["game", "turn"], s)),
          },
        }),
        turn: deep.in(["game", "turn"]).state({
          initial: "wait",
          enter: (s: Shared, _input, ctx) => ctx.stay(note(s, "enter turn")),
          states: {
            move: move.state({ enter: (_s: Shared, { x }) => ({ x }) }),
            wait: deep.in(["game", "turn", "wait"]).state({}),
          },
        }),
      },
    }),
    done: deep.in("done").state({}),
  },
  views: {},
});
