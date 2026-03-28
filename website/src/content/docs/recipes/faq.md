---
title: FAQ
description: Frequently asked questions about Actor Kit.
---

## General

### Do I need to use React?

No. The core library (`actor-kit`) and the client SDK (`actor-kit/client`) have no React dependency. You can use them with any frontend framework or vanilla JavaScript. The `actor-kit/react` package is an optional convenience layer.

### How does binary sync work?

Binary sync is automatic. When your views use `view(schema, fn)`, the framework encodes them as binary frames with delta encoding. If a view doesn't have a schema, it falls back to JSON strings. You don't need to opt in — just define your views with a schema and binary sync is enabled.

### How many actors can I have?

Each actor is a Cloudflare Durable Object. Cloudflare's platform handles scaling — you can have millions of DOs. Each DO is independently addressable and runs in the region closest to the first request that creates it.

### What happens when a Durable Object restarts?

State is automatically restored from SQLite. Any pending outbox entries (from `emit()`) are retried. Connected WebSockets receive a fresh snapshot on reconnect. From the client's perspective, there's a brief disconnect and automatic reconnection.

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

From the JWT. The `sub` claim becomes the caller identity. The `act` claim becomes the `callerType` (`"user"` or `"service"`). Tokens are validated on WebSocket connect and on every HTTP request.

## Side Effects

### How do I handle async responses from emit()?

`emit()` is fire-and-forget. For results, the pattern is: emit to a Queue → Queue consumer does the work → consumer sends a message back to the actor. See [Side Effects](/concepts/side-effects/) for the full pattern.

### What if an emitted effect fails?

Effects retry up to 3 times with backoff (1s, 5s, 25s). After 3 failures, the effect moves to the `emission_failures` SQLite table. It won't retry again automatically — you'd need to handle it manually or build a cleanup process.

### Can I emit from `lifecycle.connect` or `lifecycle.disconnect`?

Yes. Lifecycle handlers receive the same `ctx` as message handlers, including `emit()`.

## Client

### How does reconnection work?

When the WebSocket disconnects unexpectedly, the client auto-reconnects with exponential backoff (1s → 30s, max 10 attempts by default). On reconnect, the client sends a checksum of its last-known view. If the server's current view matches, it sends an ack (no data). If it differs, it sends a full snapshot.

### Can I connect to multiple actors from one page?

Yes. Create multiple client instances via `Factory.create()`, each pointing to a different actor URL. Each maintains its own WebSocket connection and view state.

## Testing

### Should I use `testActor()` or `vitest-pool-workers`?

Use `testActor()` for most tests. It's fast (pure TypeScript, no I/O) and covers role evaluation, message routing, Zod validation, guards, view projection, and side effect capture. Use `vitest-pool-workers` only when you need to test things that require the Cloudflare runtime: persistence across restarts, actual WebSocket frames, DO Alarms, or outbox drain.

### How do I test that an `emit()` was called?

Use `sendWithEffects()` from the test harness:

```typescript
const t = testActor(MyActorContract);
const state = t.init({ /* ... */ });

const { state: next, emissions } = t.sendWithEffects(
  state, "alice", { type: "NOTIFY" }
);

expect(emissions).toContainEqual(
  expect.objectContaining({ queue: "NOTIFICATIONS" })
);
```

## Deployment

### What do I need in `wrangler.jsonc`?

At minimum, your Durable Object bindings and the `ACTOR_KIT_SECRET` secret:

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

Set the secret separately:

```bash
npx wrangler secret put ACTOR_KIT_SECRET
```

### Can actors communicate across different Workers?

Not directly. Actor-to-actor communication via `emit({ actor: ... })` and `createRef()` requires both actors to be Durable Object bindings in the same Worker. For cross-Worker communication, use `emit({ fetch: ... })` to call an HTTP endpoint on the other Worker.
