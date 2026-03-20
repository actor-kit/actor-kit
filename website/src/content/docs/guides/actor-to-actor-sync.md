---
title: Actor-to-Actor Sync
description: Connect Durable Objects to each other using fromActorKit for real-time state synchronization.
---

Actors in Actor Kit can connect to other actors via WebSocket, staying synchronized in real time. This enables patterns like a session actor reading from a shared zone, or an agent actor writing to a game world — all across separate Durable Objects, potentially in different Workers.

`fromActorKit` is exported from `@actor-kit/worker` and handles the entire connection lifecycle: JWT creation, WebSocket setup, JSON Patch sync, event forwarding, and cleanup.

## Why connect actors?

- **Shared state** — a zone/room actor that multiple sessions need to read and write
- **Separation of concerns** — keep domain logic in separate actors (inventory, matchmaking, chat)
- **Cross-Worker communication** — actors in different Workers that need to stay in sync
- **Event routing** — a session receives client events and selectively forwards them to other actors

## Basic pattern

### 1. Declare the connection

In your parent machine's `setup`, register `fromActorKit` as an actor source:

```typescript
import { fromActorKit } from "@actor-kit/worker";
import type { CounterMachine } from "./counter.machine";

const aggregatorMachine = setup({
  actors: {
    counterConnection: fromActorKit<CounterMachine>("counter"),
  },
  // ...
})
```

### 2. Invoke it from a state

The `invoke` block opens the WebSocket connection when the machine enters that state. Pass the Durable Object namespace, actor ID, caller identity, and signing key:

```typescript
.createMachine({
  initial: "active",
  states: {
    active: {
      invoke: {
        id: "counterConnection",
        src: "counterConnection",
        input: ({ context }) => ({
          server: context.env.COUNTER,           // DO namespace binding
          actorId: "shared-counter",              // Remote actor ID
          actorInput: {},                         // Init props (if new)
          caller: { id: "aggregator", type: "service" as const },
          signingKey: context.env.ACTOR_KIT_SECRET,
          eventSchema: CounterClientEventSchema,  // Validates forwarded events
        }),
      },
    },
  },
})
```

### 3. Receive updates

When the remote actor's state changes, `fromActorKit` emits a `{TYPE}_UPDATED` event (e.g., `COUNTER_UPDATED`) with the caller-scoped snapshot and JSON Patch operations:

```typescript
on: {
  COUNTER_UPDATED: {
    actions: assign(({ context, event }) =>
      produce(context, (draft) => {
        draft.public.remoteCount = event.snapshot.public.count;
      })
    ),
  },
},
```

### 4. Send events to the remote actor

Use XState's `sendTo` to forward events through the connection. Events are validated against the `eventSchema` before being sent over WebSocket:

```typescript
// Direct send from an action
actions: {
  incrementRemote: sendTo("counterConnection", {
    type: "INCREMENT",
  }),
},

// Or forward client events
on: {
  INCREMENT_COUNTER: {
    actions: sendTo("counterConnection", { type: "INCREMENT" }),
  },
},
```

## Real-world example: Session + Zone

In a multiplayer game, each player has a **session** actor that connects to a shared **zone** actor. The session forwards player actions to the zone and reflects zone state back to the browser client.

```typescript
// session.machine.ts
const sessionMachine = setup({
  actors: {
    zoneConnection: fromActorKit<ZoneMachine>("zone"),
  },
  actions: {
    forwardMovement: sendTo("zoneConnection", ({ context }) => ({
      type: "ENTITY_STATE_CHANGED",
      entityId: context.public.playerId,
      position: context.public.position,
    })),
  },
}).createMachine({
  initial: "playing",
  states: {
    playing: {
      invoke: {
        id: "zoneConnection",
        src: "zoneConnection",
        input: ({ context }) => ({
          server: context.env.ZONE,
          actorId: context.public.zoneId,
          actorInput: {},
          caller: { id: context.public.playerId, type: "service" as const },
          signingKey: context.env.ACTOR_KIT_SECRET,
          eventSchema: ZoneServiceEventSchema,
        }),
      },
      on: {
        ZONE_UPDATED: {
          actions: assign(({ context, event }) =>
            produce(context, (draft) => {
              draft.public.zoneSnapshot = event.snapshot;
            })
          ),
        },
        PLAYER_MOVED: {
          actions: ["updatePosition", "forwardMovement"],
        },
      },
    },
  },
});
```

## Cross-Worker setup

When the remote actor lives in a different Cloudflare Worker, bind its Durable Object namespace in the parent Worker's `wrangler.toml`:

```toml
# Parent Worker's wrangler.toml
[[durable_objects.bindings]]
name = "SESSION"
class_name = "Session"

# Bind to Zone DO from a different Worker
[[durable_objects.bindings]]
name = "ZONE"
class_name = "Zone"
script_name = "zone-worker"
```

## What fromActorKit handles

You don't need to implement any of this yourself:

- **JWT creation** — signs a token for the remote actor using the shared secret
- **WebSocket lifecycle** — opens connection via `stub.fetch()` with upgrade header
- **JSON Patch sync** — applies incremental diffs to maintain a local snapshot
- **Event queuing** — buffers events sent before the WebSocket is ready
- **Event validation** — validates forwarded events against the Zod schema
- **Error events** — emits `{TYPE}_ERROR` if the connection fails
- **Cleanup** — closes the WebSocket when the parent actor stops

## Data flow

```
Browser Client
  │ send({ type: "PLAYER_MOVED", position })
  ▼
Session DO (parent)
  │ XState transition → "forwardMovement" action
  │ sendTo("zoneConnection", { type: "ENTITY_STATE_CHANGED", ... })
  ▼
fromActorKit WebSocket → Zone DO (remote)
  │ XState transition → updates zone state
  │ Persists snapshot → broadcasts JSON Patch diffs
  ▼
fromActorKit receives patch → emits ZONE_UPDATED
  │
Session DO updates context with zone snapshot
  │ Broadcasts caller-scoped diff to browser
  ▼
Browser re-renders via useSelector
```
