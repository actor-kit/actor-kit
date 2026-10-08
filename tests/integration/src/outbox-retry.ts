/**
 * Retrier: services that fail on purpose, for the outbox retry tests (ADR-015 D1).
 *
 * - FLAKY fails until its `succeedOn` try, then returns what the runtime passed as its third
 *   argument (effect id + try number). 3 tries, 1 ms backoff.
 * - DOOMED always fails. 2 tries, 1 ms backoff; onError counts the failures it is told about.
 * - PATIENT always fails, waiting `waitMs` between its 2 tries (the retry goes through alarm()).
 * - DEFAULTED declares no retry option: the default policy (3 tries, 1s/5s backoff).
 */

import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

export type RetrierState = { done: { effectId: string; attempt: number; input: unknown }[]; errors: string[] };

const Input = z.object({ tag: z.string(), succeedOn: z.number().optional() });
type Input = z.infer<typeof Input>;

const run = message(
  z.object({ service: z.enum(["FLAKY", "DOOMED", "PATIENT", "DEFAULTED"]), tag: z.string(), succeedOn: z.number() }),
  (state: RetrierState, { service, tag, succeedOn }, ctx: { execute: (service: string, input: unknown) => void }) => {
    ctx.execute(service, { tag, succeedOn });
    return state;
  },
);

const twice = message(z.object({}), (state: RetrierState, _p, ctx: { execute: (s: string, i: unknown) => void }) => {
  ctx.execute("FLAKY", { tag: "a", succeedOn: 1 });
  ctx.execute("FLAKY", { tag: "b", succeedOn: 1 });
  return state;
});

const fail = (tag: string): never => {
  throw new Error(`no luck: ${tag}`);
};

const RetrierContract = defineActor("retrier", {
  input: z.object({}),
  init: (): RetrierState => ({ done: [], errors: [] }),
  roles: { any: () => true },
  messages: { RUN: run, TWICE: twice },
  views: {
    any: view.shared(schema({ done: uint32, errors: uint32 }), (s: RetrierState) => ({
      done: s.done.length,
      errors: s.errors.length,
    })),
  },
  services: {
    FLAKY: {
      retry: { attempts: 3, backoff: { baseMs: 1, jitter: 0 } },
      fn: async (input: unknown, _env: unknown, effect: { effectId: string; attempt: number }) => {
        const { tag, succeedOn } = Input.parse(input);
        if (effect.attempt < (succeedOn ?? 1)) return fail(tag);
        return { effectId: effect.effectId, attempt: effect.attempt };
      },
      onDone: (state: RetrierState, result: unknown, input: unknown) => ({
        ...state,
        done: [...state.done, { ...z.object({ effectId: z.string(), attempt: z.number() }).parse(result), input }],
      }),
      onError: (state: RetrierState, error: { message: string }) => ({
        ...state,
        errors: [...state.errors, error.message],
      }),
    },
    DOOMED: {
      retry: { attempts: 2, backoff: { baseMs: 1, jitter: 0 } },
      fn: async (input: unknown) => fail(Input.parse(input).tag),
      onError: (state: RetrierState, error: { message: string }) => ({
        ...state,
        errors: [...state.errors, error.message],
      }),
    },
    PATIENT: {
      retry: { attempts: 2, backoff: { baseMs: 60_000, jitter: 0 } },
      fn: async (input: unknown) => fail(Input.parse(input).tag),
      onError: (state: RetrierState, error: { message: string }) => ({
        ...state,
        errors: [...state.errors, error.message],
      }),
    },
    DEFAULTED: {
      fn: async (input: unknown) => fail(Input.parse(input).tag),
      onError: (state: RetrierState, error: { message: string }) => ({
        ...state,
        errors: [...state.errors, error.message],
      }),
    },
  },
  studio: { enabled: true },
});

export const Retrier = createActorClass(RetrierContract);

/** Same actor with `journal: false`: effect ids come from the snapshot's transition counter. */
export const RetrierNoJournal = createActorClass(
  defineActor("retrier-no-journal", { ...RetrierContract.def, journal: false }),
);
export type { Input as RetrierInput };
