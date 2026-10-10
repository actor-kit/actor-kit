---
title: Side Effects
description: Durable async effects via services and execute().
---

## The Problem

If a handler calls an external API and then the Durable Object crashes, the API was called but the state wasn't persisted. On restart, the handler reruns — calling the API again.

Async handlers inside DOs make this worse: `await` allows message interleaving (stale state bugs), `blockConcurrencyWhile` blocks all clients during network I/O, and a crash mid-fetch leaves no durable error record.

## The Solution: Services + execute()

Actors declare named **services** at the module level. Message handlers trigger them with `execute()`. The framework handles persistence, execution, and crash recovery.

```typescript
import { defineActor, message } from "@actor-kit/worker";
import { z } from "zod";

defineActor("cart", {
  services: {
    fetchPrice: {
      fn: async (input: { itemId: string }, env) => {
        const res = await fetch(`https://api.store.com/prices/${input.itemId}`);
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json() as Promise<{ total: number }>;
      },
      onDone: (state, result, input) => ({
        ...state,
        prices: { ...state.prices, [input.itemId]: result.total },
        status: "loaded",
      }),
      onError: (state, error, input) => ({
        ...state,
        error: `${input.itemId}: ${error.message}`,
        status: "failed",
      }),
    },
    trackEvent: {
      fn: async ({ event }: { event: string }, env) => {
        await env.ANALYTICS.send({ event });
      },
    },
  },
  messages: {
    FETCH_PRICE: message(z.object({ itemId: z.string() }), (state, { itemId }, { execute }) => {
      execute("fetchPrice", { itemId });
      return { ...state, status: "loading" };
    }),
  },
});
```

A service has these parts:

- **`fn`** — async function that receives the input, the Worker `env` and the effect: `{ actorType, actorId, effectId, idempotencyKey, attempt, signal }`. Use any library: `fetch`, CF bindings (Queues, KV, R2), third-party SDKs.
- **`onDone`** — optional. Pure state transition that receives `(state, result, input)`. The result type is inferred from `fn`'s return type.
- **`errors`** — optional. The service's declared failures, a `z.discriminatedUnion("_tag", [...])`. See [Typed errors](#typed-errors).
- **`onError`** — optional. Pure state transition that receives `(state, error, input)`, where `error` is a typed, tagged error: one of the declared `errors`, `{ _tag: "Timeout", ms }` or `{ _tag: "Defect", message }`. It runs once, when the row fails for good.
- **`timeoutMs`** — optional. Time limit per try, default **30 000 ms**. When it runs out the runtime aborts `effect.signal` and the try fails as `{ _tag: "Timeout", ms }` (retried by default). Pass `effect.signal` to `fetch` and SDKs so the work actually stops. A long job must set a larger `timeoutMs`.
- **`retry`** — optional. `{ attempts, backoff: { baseMs, factor, maxMs, jitter }, while }`. Default: 3 tries, 1s then 5s apart, ±20% jitter; only `Timeout` and `Defect` are retried. `{ attempts: 1 }` turns retries off.

All three are declared at module level — no closures, fully serializable, crash-safe. The `input` argument is the original value passed to `execute()`, available in all three functions.

## Typed env

Declare the bindings an actor uses as a Zod object; the runtime parses the Worker env against it once, before the actor serves anything:

```typescript
import { d1, defineActor, durableObject, kv, queue, r2, service } from "@actor-kit/worker";

defineActor("checkout", {
  env: z.object({ PAYMENTS: service<PaymentsApi>(), SESSIONS: kv(), STRIPE_PUBLISHABLE_KEY: z.string().min(1) }),
  // ...
});
```

- `service<T>()`, `durableObject<T>()`, `queue<T>()`, `kv()`, `r2()` and `d1()` check a binding's runtime shape (its methods) and type it; plain Zod schemas check vars and secrets.
- If the env does not parse, the actor refuses every request with a **500 naming each missing or wrong binding** (RPC calls throw the same message) and logs one structured line (`actor_kit.env.invalid`, binding names and reasons, never values). It never runs a handler against an unchecked env.
- Services' `fn(input, env, effect)`, `onDone`/`onError`'s `ctx.env` and lifecycle handlers' `ctx.env` are typed `z.infer<typeof env>` by `defineActor`, and see the parsed env (the declared bindings only). Message and timer handlers are written with `message()` / `timer()`, whose types TypeScript fixes before `defineActor` sees them: annotate `ctx: MessageContext<z.infer<typeof Env>>` there.
- Without `env`, env stays `unknown` and handlers get the Worker env as it is.
- Tests take fakes typed against the schema and parse them the same way: `testActor(Contract, { env: fakes })`, `simulate({ env: { checkout: fakes } })` (keyed by contract name).

## Typed errors

A service fails with a value, not a string. Declare its failures as a tagged union and throw `fail(...)`:

```typescript
import { defineActor, fail } from "@actor-kit/worker";

services: {
  charge: {
    errors: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("CardDeclined"), reason: z.string() }),
      z.object({ _tag: z.literal("RateLimited"), retryAfterMs: z.number() }),
    ]),
    fn: async (input: { cents: number }, env, effect) => {
      const res = await env.PAYMENTS.charge(input, { idempotencyKey: effect.idempotencyKey });
      if (res.status === 402) throw fail({ _tag: "CardDeclined", reason: res.reason });
      if (res.status === 429) throw fail({ _tag: "RateLimited", retryAfterMs: res.retryAfter });
      return res.body;
    },
    retry: { attempts: 5, while: (e) => e._tag === "RateLimited" || e._tag === "Timeout" },
    onError: (state, error) => {
      // error: CardDeclined | RateLimited | Timeout | Defect
      if (error._tag === "CardDeclined") return { ...state, status: "declined", reason: error.reason };
      return { ...state, status: "failed" };
    },
  },
},
```

- `fail(error)` marks a declared failure. The runtime parses it against `errors`; a value that doesn't parse becomes a `Defect`.
- Every service's error union also has two built-ins: `{ _tag: "Timeout", ms }` (the try ran out of time) and `{ _tag: "Defect", message }` (anything thrown that isn't `fail(...)`). Without `errors`, the union is just these two.
- **Default retry rule: the built-ins are retried, declared errors are not.** A declared error is a domain answer, not a transient fault: a declined card fails at once and `onError` runs. `retry.while(error)` overrides the rule per error (above, a rate limit is retried too).
- The journal stores the parsed error, so replay and restore deliver the same typed value to `onError`.
- Studio's Outbox shows the error's `_tag` in the Last error column. A declared error's fields are application values, redacted by `studio.redact` like payloads.

## Timeouts and cancellation

Every try runs under its service's `timeoutMs` (default 30 seconds), and every forward under its link's (`link(Contract, { onUpdate, timeoutMs })`, same default). The try gets an `AbortSignal` as `effect.signal`; it is aborted when:

- the try runs out of time (the try then fails as `{ _tag: "Timeout", ms }`, which is retried by default);
- a restore undoes the transition that declared the effect (the row becomes a dead letter);
- an operator redrives the effect while an earlier try of it is still running.

A result that arrives after its try was aborted is discarded, never applied. A forward's RPC cannot be cancelled mid-flight, but its late answer is discarded the same way. The Workers runtime gives a Durable Object no shutdown hook: tries in flight when an isolate is evicted die with it and run again on wake (delivery is at least once).

## Fire-and-Forget

Services without `onDone` or `onError` are fire-and-forget. The framework runs the function after commit but discards the result:

```typescript
services: {
  trackEvent: {
    fn: async ({ event }: { event: string }, env) => {
      await env.ANALYTICS.send({ event });
    },
  },
},
```

Trigger it the same way:

```typescript
ITEM_ADDED: message(z.object({ itemId: z.string() }), (state, { itemId }, { execute }) => {
  execute("trackEvent", { event: "item_added" });
  return { ...state, items: [...state.items, itemId] };
}),
```

## Framework Execution Model

1. Message handler runs **synchronously** — returns new state (e.g., `{ status: "loading" }`)
2. State + outbox entry persisted **atomically**: `{ service: "fetchPrice", input: { itemId } }`
3. Framework runs `services.fetchPrice.fn(input, env)` **after commit**
4. On success: `onDone(currentState, result, input)` runs, state persisted, views broadcast
5. On a failure that is retried (by default `Timeout` and `Defect`) with tries left: the row waits as `retrying` and the Durable Object alarm runs it again after the backoff
6. On a failure that is not retried (by default a declared error), or of the last try: `onError(currentState, error, input)` runs with the typed error, state persisted, views broadcast; the row stays `failed`
7. On crash: restart, re-run from outbox (service name + input are serialized)

Outbox rows move through `pending` → `running` → `done`, `retrying` (and back to `running`) or `failed`. A `failed` row is a dead letter: it stays until an admin redrives it from Studio's Outbox panel, which moves it back to `pending` under the same effect id.

Messages sent with `ctx.forward(link, targetId, message)` go through the outbox too, with the same effect ids, statuses, alarm and redrive. Their retry policy belongs to the link: `link(Contract, { onUpdate, retry: { attempts, backoff } })`, same shape and defaults as a service. A send that throws (the target is unreachable) is retried; a target that cannot be resolved is a dead letter straight away. A target that answers, even with a refusal, counts as delivered.

Handlers never `await`. State is never stale. Crashes never lose intent.

## Guarantees

- **At-least-once delivery**: if the DO crashes after commit but before the service completes, the outbox entry survives. On restart, the framework re-runs the service from the persisted input.
- **No interleaving**: handlers are synchronous. State cannot change between read and write.
- **Idempotency is your responsibility**: at-least-once means duplicates are possible. Every execution has a deterministic **effect id**, `seq:index` (the transition's number and the effect's position in it). An effect id is unique only *within one actor*: two rooms at the same journal position both have effect `812:0`. Downstream, use **`effect.idempotencyKey`**, `${actorType}/${actorId}/${effectId}`, which is unique across the deployment and the same on every retry and redrive:

```typescript
charge: {
  fn: async (input: { orderId: string; cents: number }, env, effect) =>
    env.PAYMENTS.charge({ ...input, idempotencyKey: effect.idempotencyKey }),
  retry: { attempts: 5, backoff: { baseMs: 500, factor: 2 } },
},
```

Never use `effectId` alone as an idempotency key.

- **Forwards carry their effect**: a message sent with `ctx.forward()` is delivered at least once too. The target's handler reads the sender's effect as `ctx.delivery` (`{ actorType, actorId, effectId, idempotencyKey, attempt }`; `undefined` for messages that did not come through a forward) and can ignore a retried delivery it has already applied:

```typescript
DELIVER: message(z.object({ text: z.string() }), (state: Inbox, { text }, ctx) => {
  const key = ctx.delivery?.idempotencyKey;
  if (key !== undefined && state.seen.includes(key)) return state;
  return { ...state, seen: key === undefined ? state.seen : [...state.seen, key], texts: [...state.texts, text] };
}),
```

`ctx.delivery` is journaled with the event, so replay hands the same value back.

## Everything Goes Through execute()

`execute()` is the single verb for all async work:

- **Need a result?** Add `onDone` and `onError` to the service.
- **Fire-and-forget?** Skip them.
- **Need a Queue?** The service `fn` calls `env.QUEUE.send()`.
- **Need KV, R2, or D1?** The service `fn` uses env bindings directly.

## Related

- [Testing Side Effects](/recipes/testing-side-effects/) — how to capture and assert `execute()` calls in tests
