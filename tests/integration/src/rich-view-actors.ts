/** ADR-019 C: an actor whose view uses signed ints, an enum, a record, a union and json. */
import { enumOf, int16, json, record, schema, uint8, union, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

type Turn = { kind: "waiting" } | { kind: "acting"; player: number; seconds: number };
type ScoreboardState = { phase: "lobby" | "playing"; scores: Record<string, number>; turn: Turn; tags: string[] };

export const ScoreboardView = schema({
  phase: enumOf(["lobby", "playing"]),
  scores: record(int16),
  turn: union("kind", { waiting: schema({}), acting: schema({ player: uint8, seconds: uint8 }) }),
  meta: json(z.object({ tags: z.array(z.string()) })),
});

const score = message(z.object({ player: z.string(), points: z.number().int() }), (state: ScoreboardState, p) => ({
  ...state,
  phase: "playing" as const,
  scores: { ...state.scores, [p.player]: (state.scores[p.player] ?? 0) + p.points },
}));

const act = message(z.object({ player: z.number().int(), seconds: z.number().int() }), (state: ScoreboardState, p) => ({
  ...state,
  turn: { kind: "acting" as const, player: p.player, seconds: p.seconds },
}));

const remove = message(z.object({ player: z.string() }), (state: ScoreboardState, p) => ({
  ...state,
  scores: Object.fromEntries(Object.entries(state.scores).filter(([name]) => name !== p.player)),
  tags: [...state.tags, `removed:${p.player}`],
}));

const ScoreboardContract = defineActor("scoreboard", {
  input: z.object({}),
  init: (): ScoreboardState => ({ phase: "lobby", scores: {}, turn: { kind: "waiting" }, tags: [] }),
  roles: { player: () => true },
  messages: { player: { SCORE: score, ACT: act, REMOVE: remove } },
  views: {
    player: view.shared(ScoreboardView, (s: ScoreboardState) => ({
      phase: s.phase,
      scores: s.scores,
      turn: s.turn,
      meta: { tags: s.tags },
    })),
  },
});

export const Scoreboard = createActorClass(ScoreboardContract);
