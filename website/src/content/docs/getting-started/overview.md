---
title: Overview
description: What Actor Kit is and why you'd use it.
---

Actor Kit is a framework for building real-time, event-driven applications on [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/).

## The Actor Model

Each actor is a Durable Object — a single-threaded, globally addressable unit of state. It has:

- **A mailbox** — messages are processed one at a time (no race conditions)
- **Private state** — persisted to DO SQLite (survives restarts)
- **Behavior** — you define how messages change state and what clients see

## What Actor Kit Provides

A single `actor()` function defines everything:

| Concern | How |
|---------|-----|
| State shape | `init()` returns the initial state |
| Authorization | `roles` — predicates that derive roles from state |
| Event handling | `messages` — per-role handlers with Zod validation |
| Client views | `views` — per-role projections with schema-defined encoding |
| Side effects | `emit()` for fire-and-forget, `request()` for async with callbacks |
| Timers | `after` for DO Alarms, `tick` for game loops |
| Lifecycle | `on.connect` / `on.disconnect` for WebSocket events |

## Subpath Exports

Actor Kit is one package with four entry points:

```
actor-kit          → Server: actor(), schema(), view(), message(), ref()
actor-kit/client   → Browser: createActorClient(), binary decoder
actor-kit/react    → React: createActorContext(), useView(), useSend()
actor-kit/test     → Test: testActor() — no CF runtime needed
```

## Key Features

### Role-Based Access Control

Roles are derived from state, not tokens. The actor decides who has what role based on the current state.

```typescript
roles: {
  owner: (state, caller) => caller === state.ownerId,
  member: (state, caller) => state.memberIds.includes(caller),
  viewer: () => true,
},
```

### Binary Delta Sync

Views are defined with schemas that enable binary encoding. After the first snapshot, only changed fields are sent — using a bitmask to indicate which fields changed.

### Guards

Message handlers can have guards — conditions that must be true before the handler runs. The framework rejects the message if the guard fails.

```typescript
const placeBid = message(z.object({ amount: z.number() }), {
  guard: (state) => !state.closed,
  handler: (state, { amount }, { caller }) => ({ ...state, bids: [...state.bids, { caller, amount }] }),
});
```

### Transactional Side Effects

Side effects go through a SQLite outbox — persisted atomically with state. If the DO crashes, pending effects retry on restart.

```typescript
ctx.emit({ queue: "EMAIL_QUEUE", body: { to: state.memberIds } });
ctx.request({ fetch: "https://api.example.com", onDone: "FETCH_DONE", onError: "FETCH_FAILED" });
```
