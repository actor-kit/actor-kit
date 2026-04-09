# ADR 010: Services and execute() — Durable Async Effects

**Date**: 2026-03-29
**Status**: Accepted
**Supersedes**: ADR-009 section on "emit() only — no request/callback"

## Context

ADR-009 removed all async primitives (`request()`, `callback()`, async handlers) and made `emit()` to CF Queues the only way to do async work. This required a separate Queue consumer Worker for every fetch — massive overhead for simple reads like "get a price" or "check inventory."

Async handlers were considered but rejected because:
- `await` in DO handlers allows message interleaving (stale state bugs)
- `blockConcurrencyWhile` blocks all clients during network I/O
- Crash mid-fetch = silent failure, no durable error recorded

Codex cross-review confirmed: async handlers are fundamentally unsafe in DOs.

## Decision

Add a `services` block to the actor definition and an `execute()` function on the message context.

### Services

Named async functions declared at the module level with optional `onDone`/`onError` handlers:

```typescript
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
}
```

- `fn` — async function, receives payload + env. Use any library (fetch, ky, CF bindings).
- `onDone` — optional. Receives `(state, result, payload)`. Result typed from fn's return type.
- `onError` — optional. Receives `(state, error, payload)`.
- Both are defined at module level — no closures, fully serializable, crash-safe.
- `payload` is the original input passed to `execute()` — available in all three functions.

### execute()

Triggers a service from a message handler:

```typescript
FETCH_PRICE: message(z.object({ itemId: z.string() }), (state, { itemId }, { execute }) => {
  execute("fetchPrice", { itemId });
  return { ...state, status: "loading" };
}),
```

### Framework execution model

1. Handler runs synchronously → returns new state (e.g., `{ status: "loading" }`)
2. State + outbox entry persisted atomically: `{ service: "fetchPrice", payload: { itemId } }`
3. Framework runs `services.fetchPrice.fn(payload, env)` after commit
4. On success → `onDone(currentState, result, payload)` → persist → broadcast
5. On failure → `onError(currentState, error, payload)` → persist → broadcast
6. On crash → restart → re-run from outbox (service name + payload are serialized)

### Fire-and-forget

Services without `onDone`/`onError` are fire-and-forget:

```typescript
services: {
  trackEvent: {
    fn: async ({ event }: { event: string }, env) => {
      await env.ANALYTICS.send({ event });
    },
  },
}
```

### Replaces emit()

`emit()` is removed. Everything goes through `execute()`:

- Want a result? → add `onDone`/`onError`
- Fire-and-forget? → skip them
- Need a Queue? → the service fn calls `env.QUEUE.send()`
- Need KV/D1/R2? → the service fn uses env bindings

One verb. One concept.

## Consequences

### Positive

- One way to do async — no decision fatigue (async vs invoke vs emit)
- Durable — outbox persists intent, retries on crash
- No interleaving — handlers are synchronous
- No closures needed — onDone/onError get payload as third arg
- Type safe — result and payload types inferred from fn
- Use any library — services are plain async functions with env access
- Progressive — start without onDone/onError, add them when needed

### Negative

- More ceremony than async handlers for simple reads
- Services must be declared at module level (can't be inline)
- Two-phase state update (loading → loaded) instead of one

### Neutral

- `emit()` removed — Queue sends happen inside service fns
- No separate concept for fire-and-forget vs result-handling
