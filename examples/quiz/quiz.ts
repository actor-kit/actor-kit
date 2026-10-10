// Quiz actor contract (ADR-017 §1): states with typed locals. lobby → round → reveal → lobby.
// The round's answers live in the round's local and vanish when it ends; its timer is scoped to
// the round, so ending the round early cancels it. Browser-safe (no cloudflare:workers).

import { schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, type PhasedStateOf, setup } from "@actor-kit/worker/testing";
import { z } from "zod";

export type Shared = { players: string[]; scores: Record<string, number> };

const RoundLocal = z.object({ n: z.number(), answers: z.record(z.string(), z.string()) });

const quiz = setup({
  events: {
    RoundStarted: z.object({ n: z.number() }),
    RoundScored: z.object({ n: z.number(), correct: z.array(z.string()) }),
  },
  states: {
    lobby: {},
    round: { local: RoundLocal, input: z.object({ n: z.number() }) },
    reveal: {},
  },
});

export type QuizState = PhasedStateOf<typeof quiz, Shared>;

const lobby = quiz.in("lobby");
const round = quiz.in("round");
const reveal = quiz.in("reveal");

/** The answer every round asks for (a real quiz would read it from the round's question). */
export const CORRECT = "42";

function score(shared: Shared, answers: Record<string, string>): { shared: Shared; correct: string[] } {
  const correct = Object.keys(answers).filter((player) => answers[player] === CORRECT);
  const scores = { ...shared.scores };
  for (const player of correct) scores[player] = (scores[player] ?? 0) + 1;
  return { shared: { ...shared, scores }, correct };
}

const isHost = (_s: QuizState, _caller: string, { callerType }: { callerType: "user" | "service" }) =>
  callerType === "service";

const QuizView = schema({ phase: string, round: uint32, players: uint32, answered: uint32 });
const project = (st: QuizState) => ({
  phase: st.phase,
  round: st.phase === "round" ? st.local.n : 0,
  players: st.shared.players.length,
  answered: st.phase === "round" ? Object.keys(st.local.answers).length : 0,
});

export const QuizContract = defineActor("quiz", {
  input: z.object({}),
  init: (): Shared => ({ players: [], scores: {} }),
  roles: { host: isHost, player: () => true },
  events: quiz.events,
  initial: "lobby",
  // Top-level messages are accepted in every state.
  messages: {
    JOIN: quiz.message(z.object({}), (s: Shared, _p, ctx) =>
      s.players.includes(ctx.caller)
        ? s
        : { players: [...s.players, ctx.caller], scores: { ...s.scores, [ctx.caller]: 0 } },
    ),
  },
  states: {
    lobby: lobby.state({
      messages: {
        START: lobby.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("round", s, { n: 1 })),
      },
    }),
    round: round.state({
      enter: (_s: Shared, { n }, ctx) => {
        ctx.schedule("roundEnd", { in: "30s", scope: "state" });
        ctx.emit("RoundStarted", { n });
        return { n, answers: {} };
      },
      messages: {
        ANSWER: round.message(z.object({ text: z.string() }), (s: Shared, { text }, ctx) =>
          ctx.stay(s, { ...ctx.local, answers: { ...ctx.local.answers, [ctx.caller]: text } }),
        ),
        END: round.message(z.object({}), {
          guard: (_s: Shared, _p, ctx) => ctx.callerType === "service",
          handler: (s: Shared, _p, ctx) => {
            const scored = score(s, ctx.local.answers);
            ctx.emit("RoundScored", { n: ctx.local.n, correct: scored.correct });
            return ctx.goto("reveal", scored.shared);
          },
        }),
      },
      timers: {
        roundEnd: round.timer(z.object({}).optional(), (s: Shared, _p, ctx) => {
          const scored = score(s, ctx.local.answers);
          ctx.emit("RoundScored", { n: ctx.local.n, correct: scored.correct });
          return ctx.goto("reveal", scored.shared);
        }),
      },
    }),
    reveal: reveal.state({
      messages: {
        NEXT: reveal.message(z.object({}), (s: Shared, _p, ctx) => ctx.goto("lobby", s)),
      },
    }),
  },
  views: {
    host: view.shared(QuizView, project),
    player: view.shared(QuizView, project),
  },
});

export type QuizContract = typeof QuizContract;
