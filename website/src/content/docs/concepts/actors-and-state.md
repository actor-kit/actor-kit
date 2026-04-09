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
import { z } from "zod";
import { defineActor, createActorClass, message } from "@actor-kit/worker";

export const MyActorContract = defineActor("my-actor", {
  input: z.object({ name: z.string() }),
  init: (input) => ({
    name: input.name,
    count: 0,
  }),
  roles: { /* ... */ },
  messages: { /* ... */ },
  views: { /* ... */ },
});
export type MyActorContract = typeof MyActorContract;

export const MyActor = createActorClass(MyActorContract);
```

`defineActor()` returns a typed contract — not a DO class. The contract preserves all type information (state, messages, views, roles) for downstream consumers (`actorClient`, `actorContext`, `testActor`). `createActorClass()` converts the contract into a Durable Object class.

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

Whether you need to explicitly spawn an actor depends on its `input` schema.

### Auto-spawn (no required input)

Actors with no required input auto-initialize on the first `fetch()` — no `spawn()` call needed:

```typescript
input: z.object({}),
init: () => ({ count: 0 }),
```

When a client connects via WebSocket or sends an HTTP request, the actor initializes automatically if it doesn't already exist.

### Explicit spawn (required input)

Actors with required input must be spawned with `spawn({ input })` before any client can connect. This is for actors whose initial state depends on data provided at creation time:

```typescript
input: z.object({ ownerId: z.string(), title: z.string() }),
init: (input) => ({ ownerId: input.ownerId, title: input.title, items: [] }),
```

```typescript
const id = env.MY_ACTOR.idFromName("actor-123");
const stub = env.MY_ACTOR.get(id);
await stub.spawn({
  actorId: "actor-123",
  caller: "user-1",
  callerType: "user",
  input: { ownerId: "user-1", title: "My List" },
});
```

### Idempotency

`spawn()` is idempotent — calling it on an already-initialized actor is a no-op. This means it's safe to call `spawn()` every time before connecting, without checking whether the actor already exists.

## Lifecycle Events

The `lifecycle` block handles WebSocket connection events:

```typescript
lifecycle: {
  connect: (state, { caller, callerType }) => {
    return { ...state, onlineUsers: [...state.onlineUsers, caller] };
  },
  disconnect: (state, { caller, callerType }) => {
    return { ...state, onlineUsers: state.onlineUsers.filter(u => u !== caller) };
  },
},
```

`connect` and `disconnect` fire when WebSocket connections open and close. Both are full transitions — they persist state and broadcast views. Lifecycle handlers are synchronous — they return new state, not a Promise.

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

- [Side Effects](/concepts/side-effects/) — `execute()` and services for external communication
