---
title: Side Effects
description: Fire-and-forget effects and async callbacks.
---

## The Problem

If a transition calls an external API and then the DO crashes, the API was called but the state wasn't persisted. On restart, the transition reruns — calling the API again.

## The Solution: Transactional Outbox

Actor Kit provides two functions on the message context for side effects:

### `emit()` — Fire-and-Forget

```typescript
const notify = message(z.object({}), (state, _payload, { emit }) => {
  emit({ queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
  return state;  // State unchanged
});
```

`emit()` does not execute the side effect immediately. It records the intent in a SQLite outbox table, atomically with the state change. After the transaction commits, the outbox drains asynchronously.

### `request()` — Async with Callbacks

Define typed callbacks with `callback()`, then reference them in `request()`:

```typescript
import { callback, message } from "@actor-kit/worker";
import { z } from "zod";

const FetchSucceeded = callback("FETCH_SUCCEEDED", z.object({ data: z.string() }));
const FetchFailed = callback("FETCH_FAILED", z.object({ message: z.string() }));

const fetchData = message(z.object({ url: z.string() }), (state, { url }, { request }) => {
  request({
    fetch: url,
    onDone: FetchSucceeded,
    onError: FetchFailed,
  });
  return { ...state, status: "loading" };
});
```

`request()` is like `emit()` but with typed callback definitions. When the effect completes, the framework delivers the result to the actor's `callbacks` block:

```typescript
callbacks: {
  FETCH_SUCCEEDED: (state, { result }, ctx) => ({ ...state, data: result.data, status: "loaded" }),
  FETCH_FAILED: (state, { error }, ctx) => ({ ...state, error: error.message, status: "failed" }),
},
```

#### Per-request context with `meta`

Use the third argument to `callback()` to attach per-request context that gets passed back to the handler:

```typescript
const FetchSucceeded = callback(
  "FETCH_SUCCEEDED",
  z.object({ data: z.string() }),
  z.object({ itemId: z.string() }),  // meta schema
);

// In the message handler:
request({
  fetch: `https://api.example.com/items/${itemId}`,
  onDone: FetchSucceeded,
  onError: FetchFailed,
  meta: { itemId },  // passed through to the callback handler
});

// In the callbacks block:
callbacks: {
  FETCH_SUCCEEDED: (state, { result, meta }, ctx) => ({
    ...state,
    items: { ...state.items, [meta.itemId]: result.data },
  }),
},
```

## Effect Types

```typescript
// Send to a CF Queue
emit({ queue: "ANALYTICS", body: { event: "todo_added" } });

// Call an external API
emit({ fetch: "https://api.example.com/track", body: { event: "created" } });

// Send to another actor (DO-to-DO) — "AUDIT_LOG" is the DO binding name from wrangler.jsonc
emit({ actor: "AUDIT_LOG", id: "global", message: "LOG", payload: { action: "deleted" } });
```

## Guarantees

- **At-least-once delivery**: if the DO crashes after commit, pending effects retry on restart
- **Retry with backoff**: failed effects retry 3 times (1s, 5s, 25s) then move to a failures table
- **Idempotency**: each emission gets a UUID — downstream services can deduplicate

## Related

- [Actor-to-Actor Communication](/recipes/actor-to-actor/) — `emit()`, `request()`, and `createRef()` patterns for DO-to-DO messaging
- [Testing Side Effects](/recipes/testing-side-effects/) — how to capture and assert `emit()` and `request()` calls in tests
