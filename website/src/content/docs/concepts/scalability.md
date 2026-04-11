---
title: Scalability
description: How actor-kit scales — from single-user counters to multiplayer game worlds.
---

## The Actor Model on the Edge

Each actor is a Cloudflare Durable Object — a single-threaded, persistent process with its own SQLite database. Actors scale horizontally: create more actors, not bigger ones. Cloudflare runs them close to the clients that need them.

This means scalability in actor-kit is about two things:
1. **How many clients can connect to a single actor?** (fan-out)
2. **How do you decompose a large system into multiple actors?** (partitioning)

## Fan-Out: Shared vs Per-Caller Views

The biggest factor in single-actor scalability is **how many unique encoded frames** the actor must produce per state transition.

### `view.shared` — O(1) encoding

When a view doesn't depend on who's asking, all clients in that role get byte-identical frames:

```typescript
views: {
  spectator: view.shared(SpectatorView, (state) => ({
    scores: state.scores,
    currentRound: state.round,
  })),
}
```

The actor projects once and encodes once, regardless of how many spectators are connected. 100 spectators = 1 encode. 10,000 spectators = still 1 encode.

Use `view.shared` for:
- Chat rooms (everyone sees the same messages)
- Leaderboards and scoreboards
- Auction state (current bid, time remaining)
- Game lobbies (player list, ready status)
- Any "broadcast" pattern

### `view.perCaller` — O(N) encoding

When the view depends on *who's asking*, each client gets unique data:

```typescript
views: {
  player: view.perCaller(PlayerView, (state, caller) => ({
    myHand: state.hands[caller],       // only your cards
    opponentCount: state.players.length - 1,
    trick: state.trick,
  })),
}
```

The actor runs the projection and encoder once per connected client. 4 players = 4 encodes. This is fine for small player counts — a card game table with 2-8 players is well within budget.

Use `view.perCaller` for:
- Card game hands (private per player)
- Personal dashboards within a shared context
- Any view where `caller` determines what data to include

### Mixing Both

An actor can have both shared and per-caller views for different roles:

```typescript
views: {
  player: view.perCaller(PlayerView, (state, caller) => ({
    myHand: state.hands[caller],
    trick: state.trick,
  })),
  spectator: view.shared(SpectatorView, (state) => ({
    trick: state.trick,
    handSizes: state.players.map(p => state.hands[p].length),
  })),
}
```

Here, 4 players cost 4 encodes, but 1,000 spectators still cost 1 encode. The shared view handles the fan-out; the per-caller view handles the privacy.

## Practical Limits per Actor

A single Durable Object has:
- **128 MB memory** (Cloudflare limit)
- **Single-threaded execution** — one message processed at a time
- **Hibernation** — idle actors release memory, wake on next request

Rules of thumb:
- **< 100 concurrent WebSocket connections per actor** is comfortable
- **< 1,000** works with shared views and infrequent updates
- **> 1,000** — consider partitioning (see below)

The bottleneck is usually CPU (projection + encoding per transition), not memory. Shared views make fan-out nearly free. Per-caller views make it linear.

## Partitioning: Multiple Actors

When a single actor can't handle the load or the domain is naturally partitioned, split into multiple actors.

### By identity (most common)

Each user, game, room, or document is its own actor:

```
/api/counter/game-123    → Counter DO "game-123"
/api/counter/game-456    → Counter DO "game-456"
```

This is the default pattern. Cloudflare distributes DOs across its network automatically.

### By region (fog-of-war, spatial)

For large shared worlds where each player sees a subset:

```
MapRegion_5_3  →  view.shared  →  all players near (5,3)
MapRegion_5_4  →  view.shared  →  all players near (5,4)
MapRegion_6_3  →  view.shared  →  all players near (6,3)
```

Each region is a separate actor with a shared view. Players connect to the regions they can see. When a player moves across a boundary, the client disconnects from the old region and connects to the new one. Every connection within a region gets the same encoded frame — the fan-out cache handles the rest.

This turns a per-caller problem (unique fog-of-war per player) into a shared-view problem (everyone in a region sees the same tiles).

### By concern (actor-to-actor)

Split responsibilities across actor types. A game might have:

```
GameLobby    — matchmaking, player list (shared view, high fan-out)
GameTable    — game logic, hands (per-caller view, low fan-out)
Leaderboard  — scores, rankings (shared view, high fan-out)
```

Actors communicate via `ctx.execute()` (services + outbox) or `ref()` (DO-to-DO RPC). See [Actor-to-Actor Communication](/recipes/actor-to-actor).

## Anti-Patterns

### Don't put all users in one actor

A "global chat room" actor with 10,000 users will hit CPU limits encoding state on every message. Instead:
- Shard by room/channel (each room is its own actor)
- Use a relay actor that aggregates and fans out (see [Scaling with Relays](/recipes/scaling-with-relays))

### Don't use per-caller views for broadcast data

If the view doesn't actually need `caller`, use `view.shared`. The type system enforces this — `view.shared` callbacks literally can't reference `caller`.

### Don't fight the single-threaded model

Actors process one message at a time. If you need parallel computation, split work across multiple actors via services. Don't try to make one actor do everything.

## Summary

| Pattern | View Type | Encoding Cost | Max Connections | Example |
|---------|-----------|--------------|-----------------|---------|
| Broadcast | `view.shared` | O(1) | ~1,000+ | Chat, leaderboard, lobby |
| Private state | `view.perCaller` | O(N) | ~50-100 | Card hands, fog-of-war |
| Mixed | Both | O(1) + O(K) | Shared: ~1,000, PerCaller: ~50 | Game table + spectators |
| Partitioned | `view.shared` per partition | O(P) where P = partitions | ~1,000 per partition | World map regions |
