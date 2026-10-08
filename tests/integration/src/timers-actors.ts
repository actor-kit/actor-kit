/**
 * Quiz: durable timers for tests/integration/timers.test.ts (ADR-015 D2).
 *
 * - START schedules roundEnd (key `round-N`, `in` ms, payload { round, secret }).
 * - SKIP cancels the current round's timer. DEBOUNCE reschedules a fixed key.
 * - BATCH schedules several timers at absolute times (for late-firing order).
 * - LOOP schedules `again`, whose handler schedules itself with in: 0 (must not spin within one alarm).
 * - PING_LATER schedules `ping`, whose handler executes a service (timers can run effects).
 * QuizNoJournal is the same actor with `journal: false`; QuizNoStudio has Studio disabled.
 * QuizLifecycle schedules a timer on connect and cancels it on disconnect, leaving the state alone.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message, timer } from "@actor-kit/worker";
import { z } from "zod";

export type QuizState = {
  round: number;
  phase: string;
  fired: { name: string; key: string; lateBy: number; at: number; payload: unknown }[];
  pinged: number;
};

type Ctx = {
  schedule(name: string, opts: { in?: number | string; at?: number; key?: string; payload?: unknown }): void;
  cancel(key: string): void;
};

const record = (
  state: QuizState,
  name: string,
  ctx: { key: string; lateBy: number; now(): number },
  payload: unknown,
) => ({
  ...state,
  fired: [...state.fired, { name, key: ctx.key, lateBy: ctx.lateBy, at: ctx.now(), payload }],
});

const QuizContract = defineActor("quiz", {
  input: z.object({}),
  init: (): QuizState => ({ round: 0, phase: "idle", fired: [], pinged: 0 }),
  roles: { player: () => true },
  messages: {
    START: message(z.object({ inMs: z.number() }), (s: QuizState, { inMs }, ctx: Ctx) => {
      const round = s.round + 1;
      ctx.schedule("roundEnd", { in: inMs, key: `round-${round}`, payload: { round, secret: "answer-42" } });
      return { ...s, round, phase: "answering" };
    }),
    SKIP: message(z.object({}), (s: QuizState, _p, ctx: Ctx) => {
      ctx.cancel(`round-${s.round}`);
      return { ...s, phase: "idle" };
    }),
    DEBOUNCE: message(z.object({ inMs: z.number() }), (s: QuizState, { inMs }, ctx: Ctx) => {
      ctx.schedule("tick", { in: inMs, key: "debounced", payload: { inMs } });
      return s;
    }),
    BATCH: message(z.object({ at: z.array(z.number()) }), (s: QuizState, { at }, ctx: Ctx) => {
      at.forEach((when, i) => {
        ctx.schedule("tick", { at: when, key: `batch-${i}`, payload: { i } });
      });
      return s;
    }),
    LOOP: message(z.object({}), (s: QuizState, _p, ctx: Ctx) => {
      ctx.schedule("again", { in: 0, key: "again" });
      return s;
    }),
    PING_LATER: message(z.object({ inMs: z.number() }), (s: QuizState, { inMs }, ctx: Ctx) => {
      ctx.schedule("ping", { in: inMs });
      return s;
    }),
    BAD: message(z.object({}), (s: QuizState, _p, ctx: Ctx) => {
      ctx.schedule("roundEnd", { in: 10, payload: { round: "not a number" } });
      return s;
    }),
  },
  timers: {
    roundEnd: timer(z.object({ round: z.number(), secret: z.string() }), (s: QuizState, payload, ctx) => {
      const next = record(s, "roundEnd", ctx, payload);
      return s.round === payload.round ? { ...next, phase: "reveal" } : next;
    }),
    tick: timer(z.unknown(), (s: QuizState, payload, ctx) => record(s, "tick", ctx, payload)),
    again: timer(z.unknown(), (s: QuizState, payload, ctx) => {
      ctx.schedule("again", { in: 0, key: "again" });
      return record(s, "again", ctx, payload);
    }),
    ping: timer(z.unknown(), (s: QuizState, payload, ctx) => {
      ctx.execute("PING", { at: ctx.now() });
      return record(s, "ping", ctx, payload);
    }),
  },
  services: {
    PING: {
      retry: { attempts: 1 },
      fn: async () => "pong",
      onDone: (s: QuizState) => ({ ...s, pinged: s.pinged + 1 }),
    },
  },
  views: {
    player: view.shared(schema({ round: uint32, fired: uint32 }), (s: QuizState) => ({
      round: s.round,
      fired: s.fired.length,
    })),
  },
  studio: { enabled: true, redact: ["secret"] },
});

export const Quiz = createActorClass(QuizContract);
export const QuizNoJournal = createActorClass(defineActor("quiz-no-journal", { ...QuizContract.def, journal: false }));
export const QuizNoStudio = createActorClass(
  defineActor("quiz-no-studio", { ...QuizContract.def, studio: { enabled: false } }),
);
export { QuizContract };

/** Lifecycle handlers that only schedule / cancel: their transitions must still be committed. */
export const QuizLifecycle = createActorClass(
  defineActor("quiz-lifecycle", {
    ...QuizContract.def,
    lifecycle: {
      connect: (s: QuizState, { caller }: { caller: string }, ctx: Ctx) => {
        ctx.schedule("tick", { in: 60_000, key: `hello-${caller}` });
        return s;
      },
      disconnect: (s: QuizState, { caller }: { caller: string }, ctx: Ctx) => {
        ctx.cancel(`hello-${caller}`);
        return s;
      },
    },
  }),
);
