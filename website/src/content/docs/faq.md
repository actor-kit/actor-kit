---
title: FAQ
description: Frequently asked questions about Actor Kit.
---

## General

### Do I need to use React?

No. The core library (`@actor-kit/core`) and the client SDK (`@actor-kit/client`) have no React dependency. You can use them with any frontend framework or vanilla JavaScript. The `@actor-kit/react` package is an optional convenience layer.

### How does binary sync work?

Binary sync is automatic. When your views use `view(schema, fn)`, the framework encodes them as binary frames with delta encoding. If a view doesn't have a schema, it falls back to JSON strings. You don't need to opt in — just define your views with a schema and binary sync is enabled.

### How many actors can I have?

Each actor is a Cloudflare Durable Object. Cloudflare's platform handles scaling — you can have millions of DOs. Each DO is independently addressable and runs in the region closest to the first request that creates it.

### What's the throughput limit per actor?

Each actor is single-threaded. A rough guide:

| Operation type | Throughput |
|---|---|
| Simple message routing | ~1,000 msg/sec |
| Validation + state transitions | ~500–750 msg/sec |
| Storage writes + broadcasts | ~200–500 msg/sec |

Design actors around your **coordination boundary** — one DO per chat room, game session, document, or user — not one global DO. If a single actor becomes a bottleneck, shard across multiple actors keyed by a natural partition (e.g., per room, per region shard, per entity type).

### What happens when a Durable Object restarts?

State is automatically restored from SQLite. Any pending outbox entries (from `execute()`) are retried. Connected WebSockets receive a fresh snapshot on reconnect. From the client's perspective, there's a brief disconnect and automatic reconnection.

## State

### My view isn't updating — what's wrong?

Common causes:

1. **View function returns the same data** — the framework skips sending if the view hasn't changed. Make sure your view function actually reflects the state change.
2. **Role mismatch** — the caller's role might not have a view defined, or the view for their role doesn't include the field you're looking at. Check `t.role(state, caller)` in a test.
3. **Guard rejected the message** — if a guard returns `false`, the message is rejected and state doesn't change. Check your guard logic.

### Can I store Maps, Sets, or Dates in state?

Yes, but you need custom serializers since SQLite stores JSON. Use `serialize` and `restore` on the actor definition:

```typescript
serialize: (state) => ({
  ...state,
  members: [...state.members],           // Set → Array
  metadata: Object.fromEntries(state.metadata),  // Map → Object
  createdAt: state.createdAt.toISOString(),       // Date → string
}),
restore: (s) => ({
  ...s,
  members: new Set(s.members),
  metadata: new Map(Object.entries(s.metadata)),
  createdAt: new Date(s.createdAt),
}),
```

### How do I reset an actor's state?

Define a message with a guard to restrict access:

```typescript
RESET: message(z.object({}), {
  guard: (_state, _payload, ctx) => ctx.role === "admin",
  handler: () => ({ count: 0, lastUpdatedBy: null }),
}),
```

## Roles and Authorization

### What happens if no role matches?

The WebSocket connection is rejected with a 403. Every actor should either have a catch-all role (e.g., `viewer: () => true`) or explicitly reject unknown callers.

### Can a caller's role change?

Yes. Roles are re-evaluated on every state change. If a state change causes a different role predicate to match first, the caller's role changes. A role change triggers a full snapshot (not a delta) since the view shape might differ.

### How is the caller identity determined?

The Worker authenticates the caller and stamps identity using `withCallerIdentity(request, { callerId, callerType })`. The DO reads `callerId` from the `X-Actor-Kit-Caller-Id` header and `callerType` from `X-Actor-Kit-Caller-Type`. The DO trusts the Worker. All auth logic — session validation, OAuth, API keys — belongs in the Worker, not the DO.

## Side Effects

### How do I handle async responses from execute()?

Define a service with `onDone` and `onError` callbacks. When you call `execute("myService", payload)`, the framework runs the service function asynchronously. If it succeeds, `onDone(state, result, payload)` delivers the result back to your actor's state. If it fails, `onError(state, error, payload)` handles the failure. See [Side Effects](/concepts/side-effects/) for the full pattern.

### What if an executed service fails?

If the service function throws, the execution is marked as failed in SQLite. If the service definition has an `onError` callback, it runs with the error and the original payload, letting you update actor state in response to the failure (e.g., set an error flag, revert optimistic changes). There is no automatic retry — design your services to be idempotent and handle failures explicitly via `onError`.

### Can I execute services from `lifecycle.connect` or `lifecycle.disconnect`?

Lifecycle handlers receive `execute()` on ctx, but execution persistence for lifecycle hooks is not yet implemented. For now, use message handlers to trigger services.

## Client

### How does reconnection work?

When the WebSocket disconnects unexpectedly, the client auto-reconnects with exponential backoff (1s → 30s, max 10 attempts by default). On reconnect, the client sends a checksum of its last-known view. If the server's current view matches, it sends an ack (no data). If it differs, it sends a full snapshot.

### Can I connect to multiple actors from one page?

Yes. Create multiple client instances via `Factory.create()`, each pointing to a different actor URL. Each maintains its own WebSocket connection and view state.

## Testing

### Should I use `testActor()` or `vitest-pool-workers`?

Use `testActor()` for most tests. It's fast (pure TypeScript, no I/O) and covers role evaluation, message routing, Zod validation, guards, view projection, and side effect capture. Use `vitest-pool-workers` only when you need to test things that require the Cloudflare runtime: persistence across restarts, actual WebSocket frames, DO Alarms, or outbox drain.

### How do I test that an `execute()` was called?

Use `sendWithEffects()` from the test harness:

```typescript
const t = testActor(MyActorContract);
const state = t.init({ /* ... */ });

const { state: next, executions } = await t.sendWithEffects(
  state, "alice", { type: "NOTIFY" }
);

expect(executions).toContainEqual(
  expect.objectContaining({ service: "NOTIFICATIONS" })
);
```

## Deployment

### What do I need in `wrangler.jsonc`?

At minimum, your Durable Object bindings:

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "Counter" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Counter"] }
  ]
}
```

No secrets required. Auth is handled by your Worker via `withCallerIdentity()`.

### Can actors communicate across different Workers?

Not directly. Actor-to-actor communication via `link()`, services, and typed DO stubs requires both actors to be Durable Object bindings in the same Worker. For cross-Worker communication, define a service whose `fn` calls `fetch()` to an HTTP endpoint on the other Worker.
