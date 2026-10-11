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
import { createActorClass, setup } from "@actor-kit/worker";

// The kit: what the actor declares up front — events, states, env (all optional).
const myActor = setup({});

export const MyActorContract = myActor.actor("my-actor", {
  input: z.object({ name: z.string() }),
  init: (input: { name: string }) => ({
    name: input.name,
    count: 0,
  }),
  roles: { /* ... */ },
  messages: { /* myActor.message(...) */ },
  views: { /* ... */ },
});
export type MyActorContract = typeof MyActorContract;

export const MyActor = createActorClass(MyActorContract);
```

`setup()` returns the kit: the actor's declarations (`events`, `states`, `env`) and the helpers typed by them (`myActor.message()`, `myActor.timer()`, `myActor.in(state)`). `myActor.actor()` returns a typed contract — not a DO class. The contract preserves all type information (state, messages, views, roles) for downstream consumers (`actorClient`, `actorContext`, `testActor`). `createActorClass()` converts the contract into a Durable Object class.

### `input`

A Zod schema that validates the data provided when the actor is first created (`spawn`). Invalid input is rejected — the actor is never created.

### `init(input)`

Returns the initial state. The return type is inferred — no manual type annotations needed.

### `versions`

A typed chain of state versions (ADR-015). Each version names the schema of the persisted state at that version and
how to get there from the previous one:

```typescript
import { version } from "@actor-kit/worker";

const V1 = z.object({ players: z.array(z.string()) });
const V2 = z.object({ players: z.array(z.object({ id: z.string() })) });
const V3 = z.object({ players: z.array(z.object({ id: z.string(), avatar: z.string().nullable() })) });

versions: [
  version(1, V1),
  version(2, V2, {
    state: (s: z.infer<typeof V1>) => ({ players: s.players.map((id) => ({ id })) }),
    events: { JOIN: (payload) => ({ ...payload, avatar: null }) },
  }),
  version(3, V3, { rebuild: "replay" }),
],
```

- **`state`** steps the previous version's state to this one. Its argument is typed by the previous version: a step
  that takes the wrong shape, or a last version that does not describe what `init` returns, is a type error.
- **`events`** upcasts message payloads journaled before this version, by message name, when the journal is replayed.
- **`rebuild: "replay"`** rebuilds the state by replaying the whole journal under the new handlers (older payloads
  upcast) instead of stepping it. It needs the journal.

When an actor wakes with state stored by an older version, it is parsed with that version's schema, stepped (or
rebuilt) to the current version, and journaled as a `migrate` event with a checkpoint. From then on the journal
replays from that bump; `replayJournal()` refuses events written by a version that is not in the chain. Without
`versions`, an actor is at version 1. The old `version` / `migrate` options are refused.

## Time and randomness

Handlers are replayed from the journal, so they read time and randomness only through `ctx.now()`,
`ctx.random()` and `ctx.id()`: the journal records what they returned, and replay hands the same values
back. Reading the globals directly (`Date.now()`, `new Date()`, `performance.now()`, `Math.random()`,
`crypto.randomUUID()`, `crypto.getRandomValues()`) is caught three ways:

- **In tests** (`testActor`, `simulate`, `replayJournal`) every such call throws a `NondeterminismError`.
- **In production** the actor's `determinism` option decides. `"warn"` (the default) lets the call
  return the real value, logs one `actor_kit.handler.nondeterministic` line naming what was called and
  what to use instead, and flags the journal entry `nondeterministic` (Studio's timeline shows a badge).
  `"throw"` fails the transition as in tests; `"off"` patches nothing.

```typescript
export const Game = game.actor("game", { determinism: "throw", ... });
```

- **In your editor and CI** with the Biome plugin that ships in `@actor-kit/worker`. It flags those calls
  inside `message()` / `timer()` handlers and the `onDone`, `onError`, `onUpdate`, `onUnlink`, `connect`,
  `disconnect`, `enter` and `init` callbacks (a service's `fn` is not a handler and may use them):

```json
{ "plugins": ["./node_modules/@actor-kit/worker/biome/no-nondeterminism.grit"] }
```

Silence a line on purpose with `// biome-ignore lint/plugin: <why>`.

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
  connect: (state, { caller, callerConnections }) => {
    if (callerConnections > 1) return state; // already online in another tab
    return { ...state, onlineUsers: [...state.onlineUsers, caller] };
  },
  disconnect: (state, { caller, callerConnections }) => {
    if (callerConnections > 0) return state; // another tab is still open
    return { ...state, onlineUsers: state.onlineUsers.filter(u => u !== caller) };
  },
},
```

`connect` and `disconnect` fire when WebSocket connections open and close — once per socket, so a user with two tabs connects twice. The event is `{ caller, callerType, callerConnections }`, where `callerConnections` is how many sockets that caller has open after the event (the first connect sees 1, the last disconnect sees 0). Both are full transitions — they persist state and broadcast views. Lifecycle handlers are synchronous — they return new state, not a Promise.

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
