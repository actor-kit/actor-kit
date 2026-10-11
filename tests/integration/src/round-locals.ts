/**
 * Run Set Jimmy feedback 14 (ADR-019 A rows 21-23), shared by the unit and integration tests: the round
 * lives in `playing`'s local, and a move both changes the round and switches `window` ⇄ `acting`
 * (`ctx.goto(target, shared, input, { locals })`). The window's `enter` opens the round's next window
 * through `ctx.stay(shared, mergedLocal)`, updating `playing`'s local from a child's enter. `enter` and
 * `exit` log the round they see, so tests can read when the kept level's new local applies.
 */
import { goto, setup } from "@actor-kit/worker/testing";
import { z } from "zod";

export type Shared = { log: string[] };

const note = (s: Shared, line: string): Shared => ({ log: [...s.log, line] });

const Round = z.object({ round: z.number(), moves: z.number(), windows: z.number() });

export const roundLocals = setup({
  states: {
    lobby: {},
    playing: {
      local: Round,
      input: z.object({ round: z.number() }),
      states: {
        window: { local: z.object({ buys: z.array(z.string()) }) },
        acting: { local: z.object({ actor: z.string() }), input: z.object({ actor: z.string() }) },
        quiet: {},
      },
    },
  },
});

const lobby = roundLocals.in("lobby");
const playing = roundLocals.in("playing");
const window = roundLocals.in(["playing", "window"]);
const acting = roundLocals.in(["playing", "acting"]);
const quiet = roundLocals.in(["playing", "quiet"]);

const seen = (ctx: { readonly local: { readonly moves: number; readonly windows: number } }): string =>
  `moves ${ctx.local.moves} windows ${ctx.local.windows}`;

export const RoundLocals = roundLocals.actor("round-locals", {
  input: z.object({}),
  init: (): Shared => ({ log: [] }),
  roles: { any: () => true },
  initial: "lobby",
  states: {
    lobby: lobby.state({
      messages: {
        START: lobby.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("playing", s, { round: 1 })),
      },
    }),
    playing: playing.state({
      initial: "window",
      enter: (_s: Shared, { round }) => ({ round, moves: 0, windows: 0 }),
      messages: {
        // At playing's level: reenter keeps nothing above playing, so it takes no locals.
        RESTART: playing.message(z.object({}), (s: Shared, _p, ctx) => ctx.reenter(s, { round: ctx.local.round + 1 })),
        // From playing's level to a child: playing is kept, so its local can change with the move.
        HUSH: playing.message(z.object({}), (s: Shared, _p, ctx) =>
          ctx.goto(["playing", "quiet"], s, undefined, { locals: { playing: { ...ctx.local, moves: 99 } } }),
        ),
        // Untyped goto: the runtime checks what the types refuse (row 22).
        WRONG_LEVEL: playing.message(z.object({}), (s: Shared) =>
          goto(["playing", "acting"], s, { actor: "x" }, { locals: { "playing.window": { buys: [] } } }),
        ),
        NOT_KEPT: playing.message(z.object({}), (s: Shared) =>
          goto("lobby", s, undefined, { locals: { playing: { round: 1, moves: 0, windows: 0 } } }),
        ),
        BAD_OPTIONS: playing.message(z.object({}), (s: Shared) =>
          goto("lobby", s, undefined, { local: {}, locals: 5 }),
        ),
        BAD_LOCAL: playing.message(z.object({}), (s: Shared) =>
          goto(["playing", "window"], s, undefined, { locals: { playing: { round: "one" } } }),
        ),
      },
      states: {
        window: window.state({
          // Row 23: a child's enter updates its parent's local through the merged local.
          enter: (s: Shared, _input, ctx) =>
            ctx.stay(note(s, `enter window ${seen(ctx)}`), { ...ctx.local, windows: ctx.local.windows + 1, buys: [] }),
          exit: (s: Shared, ctx) => note(s, `exit window ${seen(ctx)}`),
          messages: {
            // Row 21: the round changes with the switch to acting.
            ACT: window.message(z.object({}), (s: Shared, _p, ctx) =>
              ctx.goto(
                ["playing", "acting"],
                s,
                { actor: ctx.caller },
                { locals: { playing: { ...ctx.local, moves: ctx.local.moves + 1 } } },
              ),
            ),
            // Own keys only: playing's local is left as it was.
            BUY: window.message(z.object({}), (s: Shared, _p, ctx) =>
              ctx.stay(s, { ...ctx.local, buys: [...ctx.local.buys, ctx.caller] }),
            ),
          },
        }),
        acting: acting.state({
          // Own keys only: the parent's local is kept (as before row 23).
          enter: (s: Shared, { actor }, ctx) => ctx.stay(note(s, `enter acting ${seen(ctx)}`), { actor }),
          exit: (s: Shared, ctx) => note(s, `exit acting ${seen(ctx)}`),
          messages: {
            DONE: acting.message(z.object({}), (s: Shared, _p, ctx) =>
              ctx.goto(["playing", "window"], s, undefined, {
                locals: { playing: { ...ctx.local, moves: ctx.local.moves + 1 } },
              }),
            ),
            // Without locals, the kept level keeps its local (row 8).
            PASS: acting.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto(["playing", "window"], s)),
            // reenter keeps playing: it can change the round too.
            AGAIN: acting.message(z.object({}), (s: Shared, _p, ctx) =>
              ctx.reenter(s, { actor: ctx.local.actor }, { locals: { playing: { ...ctx.local, round: 5 } } }),
            ),
          },
        }),
        quiet: quiet.state({}),
      },
    }),
  },
  views: {},
});
