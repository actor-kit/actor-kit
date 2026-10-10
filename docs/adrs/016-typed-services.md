# ADR 016: Typed Services — errors, env, timeouts, idempotency, determinism guards

**Date**: 2026-10-09
**Status**: Accepted (Jon, 2026-10-09: "before 0.2.0")
**Depends on**: ADR-010 (services), ADR-015 (effect ids, retries)
**Ideas from**: Effect (errors as values, `Schedule.whileInput`, Context/Layer, timeouts and interruption)

## Context

Services are the part of v2 people copy from the docs, and today they are the least typed part:

- `onError` receives `{ message }`. A declined card is retried exactly like a timeout.
- `env` is untyped in `fn` and in handlers. A missing binding is found at the first call in production.
- A hung `fetch` has no timeout. Its row stays `running` until the isolate dies.
- Effect ids (`812:0`) are unique only within one actor, and `fn` is not told which actor it runs for. The docs tell people to use `effectId` alone as a payment idempotency key, so two rooms at the same journal position would collide. **This is a correctness bug.**
- Determinism is only checked when `replayJournal()` fails. A handler that calls `Date.now()` passes every unit test.

We keep plain TypeScript and do not depend on Effect. An optional `@actor-kit/effect` adapter may come later.

## Decision

### 1. Idempotency: the effect carries its actor

`fn(input, env, effect)` where

```ts
type EffectInfo = {
  actorType: string;
  actorId: string;
  effectId: string;          // "812:0", unique within the actor
  idempotencyKey: string;    // `${actorType}/${actorId}/${effectId}`, unique across the deployment
  attempt: number;           // 1-based
  signal: AbortSignal;       // see 3
};
```

Docs and examples use `effect.idempotencyKey`. Forwards carry the same fields to the target in message metadata.

### 2. Typed, tagged service errors

```ts
services: {
  charge: {
    errors: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("CardDeclined"), reason: z.string() }),
      z.object({ _tag: z.literal("RateLimited"), retryAfterMs: z.number() }),
    ]),
    fn: async (input, env, effect) => {
      const res = await env.PAYMENTS.charge(input, { idempotencyKey: effect.idempotencyKey, signal: effect.signal });
      if (res.status === 402) throw fail({ _tag: "CardDeclined", reason: res.reason });
      if (res.status === 429) throw fail({ _tag: "RateLimited", retryAfterMs: res.retryAfter });
      return res.body;
    },
    retry: { attempts: 5, while: (e) => e._tag === "RateLimited" || e._tag === "Timeout" },
    onError: (state, error) => /* error: CardDeclined | RateLimited | Timeout | Defect */ state,
  },
},
```

- `fail(error)` (exported from `@actor-kit/worker`) marks a declared failure. It is parsed against `errors`; a value that doesn't parse becomes a `Defect`.
- Every error union also contains two built-ins: `{ _tag: "Timeout", ms }` and `{ _tag: "Defect", message }` (anything thrown that isn't `fail(...)`).
- **Default retry rule: built-ins (`Timeout`, `Defect`) are retried, declared errors are not.** `retry.while(error)` overrides it per error. A declared error is a domain answer, not a transient fault.
- The journal stores the parsed error, so replay and restore deliver the same typed value. Studio shows `_tag` in the outbox "Last error" column.
- Without `errors`, the union is just the two built-ins. `onError` changes from `{ message }` to that union (`Defect` keeps `message`). No shim: there's no production data.

### 3. Timeouts and cancellation

- `timeoutMs` per service and per link (forwards), **default 30 000**. On expiry the runtime aborts `effect.signal` and records `{ _tag: "Timeout", ms }`, which is retryable by default.
- Redrive, restore (ADR-015 D3) and actor shutdown abort the signal of any in-flight attempt. A result that arrives after its attempt was aborted is discarded, never applied.

### 4. Typed `env`, parsed once

```ts
defineActor("checkout", {
  env: z.object({ PAYMENTS: service<PaymentsApi>(), STRIPE_PUBLISHABLE_KEY: z.string().min(1) }),
  ...
});
```

- `env` is a Zod object. `service<T>()`, `durableObject<T>()`, `queue<T>()`, `kv()`, `r2()`, `d1()` are helpers exported from `@actor-kit/worker` that check the binding's runtime shape and type it.
- `createActorClass` parses `env` on the first request. On failure the actor refuses every request with a 500 naming each missing or wrong binding, and logs one structured line. It never runs a handler against an unchecked env.
- `fn`'s `env`, `ctx.env` in handlers and lifecycle, and service `onDone`/`onError` see `z.infer<typeof env>`.
- Without `env`, it stays `unknown` (no breakage for actors that use none).
- `testActor(contract, { env })` and `simulate({ env: { Contract: fakes } })` take fakes typed against the schema.

### 5. Determinism guards in the test harness

While a handler (message, lifecycle, timer, `init`, `onDone`, `onError`, link callbacks) runs under `testActor()`, `simulate()` or `replayJournal()`, these throw `NondeterminismError("use ctx.now()")` and similar: `Date.now`, `new Date()` without arguments, `performance.now`, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`. They are restored after the handler returns, including when it throws. `fn` (the async part of a service) is exempt. The Workers runtime does not patch globals.

## Order of work

1. Idempotency fields (bug fix first).
2. Typed errors + default retry rule + journal/Studio.
3. Timeouts and abort on redrive/restore/shutdown.
4. Typed `env` + binding helpers + harness fakes.
5. Determinism guards.

Each step is test-first, with Stryker ≥ 90% (survivors justified in `docs/quality.md`) and CRAP < 8 on changed code.

## Consequences

- **Positive:** declined cards stop being retried; a timeout can no longer leave a row `running`; idempotency keys can't collide across actors; a missing binding fails loudly at the first request with its name; `Date.now()` in a handler fails the first unit test.
- **Negative:** `onError`'s argument changes shape; every service gets a default 30-second timeout (a long job must set `timeoutMs`); patching globals in the harness must be restored exactly, or tests leak.
