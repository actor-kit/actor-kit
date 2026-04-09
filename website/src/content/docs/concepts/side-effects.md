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
      fn: async (payload: { itemId: string }, env) => {
        const res = await fetch(`https://api.store.com/prices/${payload.itemId}`);
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json() as Promise<{ total: number }>;
      },
      onDone: (state, result, payload) => ({
        ...state,
        prices: { ...state.prices, [payload.itemId]: result.total },
        status: "loaded",
      }),
      onError: (state, error, payload) => ({
        ...state,
        error: `${payload.itemId}: ${error.message}`,
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

A service has three parts:

- **`fn`** — async function that receives the payload and the Worker `env`. Use any library: `fetch`, CF bindings (Queues, KV, R2), third-party SDKs.
- **`onDone`** — optional. Pure state transition that receives `(state, result, payload)`. The result type is inferred from `fn`'s return type.
- **`onError`** — optional. Pure state transition that receives `(state, error, payload)`.

All three are declared at module level — no closures, fully serializable, crash-safe. The `payload` argument is the original input passed to `execute()`, available in all three functions.

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
2. State + outbox entry persisted **atomically**: `{ service: "fetchPrice", payload: { itemId } }`
3. Framework runs `services.fetchPrice.fn(payload, env)` **after commit**
4. On success: `onDone(currentState, result, payload)` runs, state persisted, views broadcast
5. On failure: `onError(currentState, error, payload)` runs, state persisted, views broadcast
6. On crash: restart, re-run from outbox (service name + payload are serialized)

Handlers never `await`. State is never stale. Crashes never lose intent.

## Guarantees

- **At-least-once delivery**: if the DO crashes after commit but before the service completes, the outbox entry survives. On restart, the framework re-runs the service from the persisted payload.
- **No interleaving**: handlers are synchronous. State cannot change between read and write.
- **Idempotency is your responsibility**: at-least-once means duplicates are possible. If your downstream service can't handle replays, add an idempotency key to the payload (e.g., `execute("charge", { orderId, idempotencyKey: crypto.randomUUID() })`).

## Everything Goes Through execute()

`execute()` is the single verb for all async work:

- **Need a result?** Add `onDone` and `onError` to the service.
- **Fire-and-forget?** Skip them.
- **Need a Queue?** The service `fn` calls `env.QUEUE.send()`.
- **Need KV, R2, or D1?** The service `fn` uses env bindings directly.

## Related

- [Testing Side Effects](/recipes/testing-side-effects/) — how to capture and assert `execute()` calls in tests
