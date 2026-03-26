---
title: Actors & State
description: How actors work and how state is managed.
---

## The Actor Model

An actor is a unit of computation with:
- **A mailbox** — messages arrive and are processed one at a time
- **Private state** — only the actor can read/write its state
- **Behavior** — a function from (state, message) → new state

In Actor Kit, each actor is a Cloudflare Durable Object. DOs are single-threaded and globally addressable — they're natural actors.

## Defining an Actor

```typescript
import { actor } from "actor-kit";
import { z } from "zod";

export const MyActor = actor("my-actor", {
  input: z.object({ name: z.string() }),
  init: (input) => ({
    name: input.name,
    count: 0,
  }),
  roles: { /* ... */ },
  messages: { /* ... */ },
  views: { /* ... */ },
});
```

### `input`

A Zod schema that validates the data provided when the actor is first created (`spawn`). Invalid input is rejected — the actor is never created.

### `init(input)`

Returns the initial state. The return type is inferred — no manual type annotations needed.

### `version`

An optional version number for migration:

```typescript
version: 2,
migrate: (persisted, fromVersion) => {
  if (fromVersion < 2) {
    return { ...persisted, newField: "default" };
  }
  return persisted;
},
```

## Persistence

State is automatically persisted to DO SQLite after every transition. When the DO restarts (after hibernation or a deploy), state is restored.

### Custom Serialization

If your state contains non-JSON-safe values (Maps, Sets, Dates), provide custom serializers:

```typescript
serialize: (state) => ({
  ...state,
  createdAt: state.createdAt.toISOString(),
}),
restore: (serialized) => ({
  ...serialized,
  createdAt: new Date(serialized.createdAt),
}),
```

## Spawning Actors

Actors are created via the `spawn()` method on the DO stub:

```typescript
const id = env.MY_ACTOR.idFromName("actor-123");
const stub = env.MY_ACTOR.get(id);
await stub.spawn({
  actorId: "actor-123",
  caller: "user-1",
  callerType: "user",
  input: { name: "My Actor" },
});
```

`spawn()` is idempotent — calling it again on an existing actor is a no-op.

## Lifecycle Events

The `on` block handles connection lifecycle and async request callbacks:

```typescript
on: {
  connect: (state, caller, ctx) => {
    return { ...state, onlineUsers: [...state.onlineUsers, caller] };
  },
  disconnect: (state, caller, ctx) => {
    return { ...state, onlineUsers: state.onlineUsers.filter(u => u !== caller) };
  },
  // Callbacks from request() — see Side Effects
  FETCH_SUCCEEDED: (state, result) => ({ ...state, data: result }),
  FETCH_FAILED: (state, error) => ({ ...state, error: error.message }),
},
```

`connect` and `disconnect` fire when WebSocket connections open and close. Both are full transitions — they persist state and broadcast views. The `ctx` parameter provides `emit()` and `request()` for triggering side effects from lifecycle events.

## Observability

The optional `observe.onTransition` hook fires after every successful state transition:

```typescript
observe: {
  onTransition(prevState, nextState, event, ctx) {
    console.log(`[${ctx.role}] ${event.type}: state changed`);
  },
},
```

This is useful for logging, metrics, or debugging. It also fires during `testActor()` tests.

## Related

- [Sequential and Parallel States](/recipes/sequential-and-parallel-states/) — multi-phase workflows and independent state regions
- [Side Effects](/concepts/side-effects/) — `emit()` and `request()` for external communication
