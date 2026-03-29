---
title: Side Effects
description: Fire-and-forget effects via emit() and Queues.
---

## The Problem

If a transition calls an external API and then the DO crashes, the API was called but the state wasn't persisted. On restart, the transition reruns — calling the API again.

## The Solution: Transactional Outbox

Actors are pure state machines. They transform state and declare intents via `emit()`. All external I/O is handled by Queue consumers or Workflows.

### `emit()` — Fire-and-Forget

```typescript
const notify = message(z.object({}), (state, _payload, { emit }) => {
  emit({ queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
  return state;  // State unchanged
});
```

`emit()` does not execute the side effect immediately. It records the intent in a SQLite outbox table, atomically with the state change. After the transaction commits, the outbox drains asynchronously.

### Results Come Back as Messages

When external I/O needs to inform state, the pattern is:

1. **Actor emits intent** to a CF Queue
2. **Queue consumer Worker** receives the message, does the actual I/O
3. **Queue consumer sends the result** back to the actor as a normal message via `stub.send()`

**Step 1 — Actor emits intent:**

```typescript
// In your actor definition
messages: {
  FETCH_PRICE: message(z.object({ itemId: z.string() }), (state, { itemId }, { emit }) => {
    emit({ queue: "EFFECTS", body: { type: "FETCH_PRICE", itemId, actorId: "price-checker-1" } });
    return { ...state, status: "loading" };
  }),

  // This message will be sent by the Queue consumer after the fetch completes
  PRICE_RESULT: message(z.object({ itemId: z.string(), total: z.number() }), (state, { itemId, total }) => ({
    ...state,
    prices: { ...state.prices, [itemId]: total },
    status: "loaded",
  })),
},
```

**Step 2 — Queue consumer Worker does the fetch and sends result back:**

```typescript
// A separate Worker that processes the EFFECTS queue
// wrangler.toml: [[queues.consumers]] queue = "EFFECTS"

import { withCallerIdentity } from "@actor-kit/worker";

export default {
  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      const { type, itemId, actorId } = msg.body;

      if (type === "FETCH_PRICE") {
        try {
          // Do the actual fetch — real fetch(), no wrappers
          const res = await fetch(`https://api.example.com/prices/${itemId}`);
          const { total } = await res.json();

          // Send result back to the actor as a normal message
          const stub = env.PRICE_CHECKER.get(env.PRICE_CHECKER.idFromName(actorId));
          await stub.send("system", "service", { type: "PRICE_RESULT", itemId, total });
        } catch (e) {
          // Handle errors — retry, dead-letter, or send error message back
          const stub = env.PRICE_CHECKER.get(env.PRICE_CHECKER.idFromName(actorId));
          await stub.send("system", "service", { type: "PRICE_ERROR", itemId, error: e.message });
        }
      }

      msg.ack();
    }
  },
};
```

The actor never does `fetch()` directly. It emits the intent, the Queue consumer does the work, and the result arrives as a typed message. This keeps the actor a pure state machine — and CF Queues handle retry and dead-letter for you.

## Effect Types

```typescript
// Send to a CF Queue
emit({ queue: "ANALYTICS", body: { event: "todo_added" } });

// Call an external API (fire-and-forget)
emit({ fetch: "https://api.example.com/track", body: { event: "created" } });

// Send to another actor (DO-to-DO) — "AUDIT_LOG" is the DO binding name from wrangler.jsonc
emit({ actor: "AUDIT_LOG", id: "global", message: "LOG", payload: { action: "deleted" } });
```

## Guarantees

- **At-least-once delivery**: if the DO crashes after commit, pending effects retry on restart
- **Retry with backoff**: failed effects retry 3 times (1s, 5s, 25s) then move to a failures table
- **Idempotency is your responsibility**: at-least-once means duplicates are possible. If your downstream service can't handle replays, add an idempotency key to the message body (e.g., `emit({ queue: "PAYMENTS", body: { orderId, idempotencyKey: crypto.randomUUID() } })`)

## Related

- [Actor-to-Actor Communication](/recipes/actor-to-actor/) — `emit()` and typed DO stub patterns for DO-to-DO messaging
- [Testing Side Effects](/recipes/testing-side-effects/) — how to capture and assert `emit()` calls in tests
