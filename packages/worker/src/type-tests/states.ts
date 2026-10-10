/**
 * Type-level tests (checked by `pnpm typecheck`): states with typed locals (ADR-017 §1). Each
 * @ts-expect-error must be an error, or the typecheck fails.
 */
import { z } from "zod";
import { defineActor } from "../define";
import { type PhasedStateOf, setup } from "../setup";

type S = { n: number };
const kit = setup({
  events: { Started: z.object({ n: z.number() }) },
  states: {
    idle: {},
    playing: { local: z.object({ n: z.number(), moves: z.array(z.string()) }), input: z.object({ n: z.number() }) },
    done: { local: z.object({ winner: z.string() }) },
  },
});
const idle = kit.in("idle");
const playing = kit.in("playing");

export const start = idle.message(z.object({}), (s: S, _p, ctx) => {
  const phase: "idle" = ctx.phase;
  const local: null = ctx.local;
  // @ts-expect-error playing needs its enter input
  ctx.goto("playing", s);
  // @ts-expect-error not a declared state
  ctx.goto("paused", s);
  // @ts-expect-error wrong input
  ctx.goto("playing", s, { n: "1" });
  // @ts-expect-error idle has no local to give
  ctx.stay(s, { n: 1 });
  // @ts-expect-error the shared state's type is fixed by the handler
  ctx.goto("idle", { m: 1 });
  void phase;
  void local;
  return ctx.goto("playing", s, { n: 1 });
});

export const move = playing.message(z.object({ m: z.string() }), (s: S, { m }, ctx) => {
  const moves: string[] = ctx.local.moves;
  ctx.emit("Started", { n: ctx.local.n });
  // @ts-expect-error not a field of the local
  void ctx.local.score;
  // @ts-expect-error a local of the wrong shape
  ctx.stay(s, { n: 1 });
  // @ts-expect-error not a declared event
  ctx.emit("Nope", {});
  return m === "end" ? ctx.goto("done", s) : ctx.stay(s, { ...ctx.local, moves: [...moves, m] });
});

export const playingState = playing.state({
  enter: (_s: S, { n }, ctx) => {
    ctx.schedule("tick", { in: 10, scope: "state" });
    const phase: "playing" = ctx.phase;
    void phase;
    return { n, moves: [] };
  },
  messages: { MOVE: move },
});

// @ts-expect-error enter must return the state's local
export const badEnter = playing.state({ enter: () => ({ n: 1 }) });

export const guarded = playing.message(z.object({}), {
  guard: (_s: S, _p, ctx) => ctx.local.moves.length < 9,
  handler: (s: S) => s,
});

type Snapshot = PhasedStateOf<typeof kit, S>;
export function describe(state: Snapshot): string {
  if (state.phase === "playing") return state.local.moves.join(",");
  if (state.phase === "done") return state.local.winner;
  const nothing: null = state.local;
  return String(nothing);
}

export const Game = defineActor("game", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: { any: () => true },
  events: kit.events,
  initial: "idle",
  states: { idle: idle.state({ messages: { START: start } }), playing: playingState, done: kit.in("done").state({}) },
  views: {},
});
