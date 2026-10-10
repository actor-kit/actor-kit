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
- **`onError`** — optional. Pure state transition that receives `(state, error, input)`. It runs once, after the last try has failed.
- **`retry`** — optional. `{ attempts, backoff: { baseMs, factor, maxMs, jitter } }`. Default: 3 tries, 1s then 5s apart, ±20% jitter. `{ attempts: 1 }` turns retries off.

All three are declared at module level — no closures, fully serializable, crash-safe. The `input` argument is the original value passed to `execute()`, available in all three functions.

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
5. On failure with tries left: the row waits as `retrying` and the Durable Object alarm runs it again after the backoff
6. On failure of the last try: `onError(currentState, error, input)` runs, state persisted, views broadcast; the row stays `failed`
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
