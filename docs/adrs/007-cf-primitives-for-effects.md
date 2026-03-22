# ADR 007: Use CF Queues and Workflows for Side Effects

**Date**: 2026-03-22
**Status**: Accepted (Phase 5 migration, SQLite outbox is Phase 1 interim)

## Context

Phase 1 implements a custom SQLite outbox for side effects (`emit()` and `request()`). The outbox persists effect intents atomically with state, then drains them asynchronously with retry logic. This works but reimplements durability guarantees that Cloudflare already provides.

CF offers two primitives that overlap:
- **CF Queues**: at-least-once message delivery with built-in retry and dead-letter
- **CF Workflows**: durable async execution with step-level persistence and retry

## Decision

### Phase 1 (current): SQLite outbox

Keep the custom outbox. It works without extra CF configuration, makes the framework self-contained for local development, and lets us ship Phase 1 without depending on Queue/Workflow bindings.

### Phase 5: Migrate to CF primitives

Replace the outbox internals while preserving the `emit()`/`request()` API surface.

**`emit()` → CF Queues directly**

```typescript
// User code stays the same:
ctx.emit({ queue: "EMAIL_QUEUE", body: { to: members } });

// Phase 1 internal: SQLite outbox → drain → env.EMAIL_QUEUE.send()
// Phase 5 internal: await env.EMAIL_QUEUE.send() directly in the transition
```

The atomicity concern (crash between queue.send and state persist) is acceptable because:
- Queues provide at-least-once delivery — the worst case is a duplicate
- Downstream consumers should be idempotent (the emit ID serves as idempotency key)
- The alternative (SQLite outbox) adds latency and complexity for marginal safety

**`request()` → CF Workflows**

```typescript
// User code stays the same:
ctx.request({
  fetch: "https://api.example.com/data",
  onDone: "FETCH_SUCCEEDED",
  onError: "FETCH_FAILED",
});

// Phase 1 internal: SQLite outbox → drain → fetch → deliver callback
// Phase 5 internal: Create a CF Workflow instance that:
//   1. Executes the fetch (durable step with retry)
//   2. Calls back to the DO via RPC with onDone/onError
```

Workflows provide:
- Durable step execution — each step persisted, retried on failure
- Built-in exponential backoff and configurable retry
- Timeouts and cancellation
- No custom drain/retry code needed

### What changes

| Concern | Phase 1 (SQLite outbox) | Phase 5 (CF primitives) |
|---------|------------------------|------------------------|
| `emit()` fire-and-forget | SQLite → drain → queue.send | queue.send directly |
| `request()` with callback | SQLite → drain → execute → callback | Workflow → execute → RPC callback |
| Retry logic | Custom (3 attempts, 1s/5s/25s) | CF built-in (configurable) |
| Dead letter | emission_failures table | CF Queue DLQ / Workflow failure |
| Atomicity with state | Same SQLite transaction | Best-effort (idempotency keys) |
| Local dev | Works standalone | Requires wrangler Queue/Workflow bindings |

### What doesn't change

- `emit()` and `request()` API surface
- `on` block callback pattern (onDone/onError message names)
- User code in message handlers

## Consequences

- Phase 1 ships with a working but non-optimal outbox (custom SQLite drain)
- Phase 5 replaces internals with CF primitives for better reliability and less code
- Users need Queue and Workflow bindings in wrangler.toml for Phase 5 features
- The `emit()`/`request()` API is designed to survive this migration — no breaking changes
