/**
 * Typed services (ADR-016), for tests/integration/typed-services.test.ts.
 *
 * - Teller runs services and forwards. ECHO returns what the runtime passed as its third argument
 *   (minus the signal). FORWARD sends DELIVER to a Till through the `till` link.
 * - Till records `ctx.delivery` for every DELIVER it accepts and ignores a delivery it has already seen.
 * - §2 typed errors: DECLINE fails with a declared CardDeclined (5 tries allowed, never retried);
 *   BROKEN throws a plain Error (a Defect, retried: 2 tries); MISFIT fails with a tag its `errors` does not
 *   declare (a Defect); LIMITED fails with RateLimited on its first try and `retry.while` retries it.
 *   Every onError records the error it gets.
 */

import type { DeliveryInfo } from "@actor-kit/core";
import { schema, uint32, view } from "@actor-kit/core";
import {
  createActorClass,
  defineActor,
  durableObject,
  type EffectInfo,
  fail,
  kv,
  link,
  message,
} from "@actor-kit/worker";
import { z } from "zod";

type TillState = { received: Array<{ text: string; delivery: DeliveryInfo | null }> };

const TillContract = defineActor("till", {
  input: z.object({}),
  init: (): TillState => ({ received: [] }),
  roles: { any: () => true },
  messages: {
    DELIVER: message(z.object({ text: z.string() }), (s: TillState, { text }, ctx) => {
      const key = ctx.delivery?.idempotencyKey;
      if (key !== undefined && s.received.some((r) => r.delivery?.idempotencyKey === key)) return s;
      return { received: [...s.received, { text, delivery: ctx.delivery ?? null }] };
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: TillState) => ({ n: s.received.length })) },
});

export type TellerState = { echoes: unknown[]; errors: unknown[] };

const echo = (effect: EffectInfo) => ({
  actorType: effect.actorType,
  actorId: effect.actorId,
  effectId: effect.effectId,
  idempotencyKey: effect.idempotencyKey,
  attempt: effect.attempt,
  signalAborted: effect.signal.aborted,
});

const PayErrors = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("CardDeclined"), reason: z.string() }),
  z.object({ _tag: z.literal("RateLimited"), retryAfterMs: z.number() }),
]);

/** Why each SLOW / HANG try's signal was aborted, by idempotency key (one isolate in the test pool). */
export const abortedTries = new Map<string, string>();

const fast = (attempts: number) => ({ attempts, backoff: { baseMs: 1, factor: 1, jitter: 0 } });
const recordError = (s: TellerState, error: unknown): TellerState => ({ ...s, errors: [...s.errors, error] });
const recordEcho = (s: TellerState, result: unknown): TellerState => ({ ...s, echoes: [...s.echoes, result] });

const TellerContract = defineActor("teller", {
  input: z.object({}),
  init: (): TellerState => ({ echoes: [], errors: [] }),
  roles: { any: () => true },
  links: { till: link(TillContract, { onUpdate: <S>(s: S) => s }) },
  services: {
    ECHO: {
      fn: async (_input: unknown, _env: unknown, effect: EffectInfo) => echo(effect),
      onDone: recordEcho,
    },
    DECLINE: {
      errors: PayErrors,
      retry: fast(5),
      fn: async (): Promise<never> => {
        throw fail({ _tag: "CardDeclined", reason: "stolen card" });
      },
      onError: recordError,
    },
    BROKEN: {
      errors: PayErrors,
      retry: fast(2),
      fn: async (): Promise<never> => {
        throw new Error("socket hang up");
      },
      onError: recordError,
    },
    MISFIT: {
      errors: PayErrors,
      retry: fast(1),
      fn: async (): Promise<never> => {
        throw fail({ _tag: "Stolen" });
      },
      onError: recordError,
    },
    SLOW: {
      timeoutMs: 50,
      retry: fast(1),
      fn: async (_input: unknown, _env: unknown, effect: EffectInfo) => {
        await new Promise((resolve) => effect.signal.addEventListener("abort", resolve));
        abortedTries.set(effect.idempotencyKey, String(JSON.stringify(effect.signal.reason)));
        return "late";
      },
      onDone: recordEcho,
      onError: recordError,
    },
    HANG: {
      retry: fast(1),
      fn: async (_input: unknown, _env: unknown, effect: EffectInfo) => {
        await new Promise((resolve) => effect.signal.addEventListener("abort", resolve));
        abortedTries.set(effect.idempotencyKey, String(effect.signal.reason));
        return "late";
      },
      onDone: recordEcho,
      onError: recordError,
    },
    LIMITED: {
      errors: PayErrors,
      retry: { ...fast(3), while: (error) => error._tag === "RateLimited" },
      fn: async (_input: unknown, _env: unknown, effect: EffectInfo) => {
        if (effect.attempt === 1) throw fail({ _tag: "RateLimited", retryAfterMs: 1 });
        return { attempt: effect.attempt };
      },
      onDone: recordEcho,
      onError: recordError,
    },
  },
  messages: {
    RUN: message(z.object({ service: z.string() }), (s: TellerState, { service }, ctx) => {
      ctx.execute(service, {});
      return s;
    }),
    FORWARD: message(z.object({ to: z.string(), text: z.string() }), (s: TellerState, { to, text }, ctx) => {
      ctx.forward("till", to, { type: "DELIVER", text });
      return s;
    }),
  },
  views: { any: view.shared(schema({ n: uint32 }), (s: TellerState) => ({ n: s.echoes.length })) },
  studio: { enabled: true },
});

export { TellerContract };
export const Teller = createActorClass(TellerContract);
export const Till = createActorClass(TillContract);

// --- §4 typed env ---

type EnvState = { keys: string[] };

const envView = { any: view.shared(schema({ n: uint32 }), (s: EnvState) => ({ n: s.keys.length })) };

/** Its env schema matches the test worker: handlers and services see only the declared bindings. */
const Typed = defineActor("env-typed", {
  input: z.object({}),
  init: (): EnvState => ({ keys: [] }),
  env: z.object({ STUDIO_CALLER_HASH_KEY: z.string().min(1), TELLER: durableObject() }),
  roles: { any: () => true },
  services: {
    KEYS: {
      fn: async (_input: unknown, env: Record<string, unknown>) => Object.keys(env).sort(),
      onDone: (_s: EnvState, result: unknown, _input: unknown, ctx: { env: Record<string, unknown> }) => ({
        keys: [...z.array(z.string()).parse(result), `onDone:${Object.keys(ctx.env).length}`],
      }),
    },
  },
  messages: {
    KEYS: message(z.object({}), (s: EnvState, _p, ctx) => {
      ctx.execute("KEYS", {});
      return s;
    }),
  },
  views: envView,
  studio: { enabled: true },
});

/** Its env schema needs bindings the test worker does not have: every request is refused. */
const Misbound = defineActor("env-misbound", {
  input: z.object({}),
  init: (): EnvState => ({ keys: [] }),
  env: z.object({ SESSIONS: kv(), STRIPE_KEY: z.string().min(1), TELLER: durableObject() }),
  roles: { any: () => true },
  messages: { PING: message(z.object({}), (s: EnvState) => s) },
  views: envView,
});

export const EnvTyped = createActorClass(Typed);
export const EnvMisbound = createActorClass(Misbound);
