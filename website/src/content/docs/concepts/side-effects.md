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

When external I/O needs to inform state, the Queue consumer sends the result back as a normal message:

```typescript
messages: {
  // Initiate: emit intent to a Queue
  FETCH_PRICE: message(z.object({ itemId: z.string() }), (state, { itemId }, { emit }) => {
    emit({ queue: "EFFECTS", body: { type: "FETCH_PRICE", itemId } });
    return { ...state, status: "loading" };
  }),

  // Result comes back as a normal message (sent by the Queue consumer)
  PRICE_RESULT: message(z.object({ itemId: z.string(), total: z.number() }), (state, { itemId, total }) => ({
    ...state,
    prices: { ...state.prices, [itemId]: total },
    status: "loaded",
  })),
},
```

The Queue consumer is a separate Worker that does the actual fetch and sends the result back via `stub.send()`.

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
