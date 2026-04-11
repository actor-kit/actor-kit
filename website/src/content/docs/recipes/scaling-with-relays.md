---
title: Scaling with Relays
description: Handle thousands of connections using relay actors.
---

A single Durable Object can handle hundreds of WebSocket connections comfortably, but not hundreds of thousands. Every state change calls `broadcastViews()`, which encodes and sends a frame to every connected client — O(N) per transition. At scale, this becomes the bottleneck.

Relay actors solve this by splitting fan-out across multiple DOs.

## The Pattern

```
Source DO (1) ──link──> Relay DOs (100) ──WebSocket──> Clients (100K)
```

The source actor holds all state and runs all transitions. Relay actors subscribe to the source via `link()` and forward views to their own WebSocket clients. The source broadcasts to ~100 relays instead of 100,000 clients. Each relay broadcasts to ~1,000 clients.

## Source Actor

The source actor doesn't change. It defines state, messages, and views as usual. Relay DOs appear as linked subscribers — the source treats them the same as any other subscriber.

```typescript
const GameContract = defineActor("game", {
  // ... normal actor definition
  roles: {
    service: (state, caller, { callerType }) => callerType === "service",
    admin: (state, caller) => state.adminId === caller,
    player: (state, caller) => state.playerIds.includes(caller),
    spectator: () => true,
  },
  views: {
    service: view.shared(ServiceView, (state) => ({
      players: state.players,
      settings: state.settings,
      scores: state.scores,
      status: state.status,
    })),
    admin: view.shared(AdminView, (state) => ({ /* ... */ })),
    player: view.shared(PlayerView, (state) => ({ /* ... */ })),
    spectator: view.shared(SpectatorView, (state) => ({ /* ... */ })),
  },
});
```

The `service` role returns a superset view — all the data any client role might need. Relays connect as services.

## Relay Actor

The relay links to the source actor and passes through views to its own clients.

```typescript
const RelayContract = defineActor("relay", {
  input: z.object({ sourceId: z.string() }),

  links: {
    source: link(GameContract, {
      onUpdate: (state, view) => ({ ...state, currentView: view }),
    }),
  },

  init: (input) => ({
    sourceId: input.sourceId,
    currentView: null as LinkedView<GameContract> | null,
  }),

  roles: { viewer: () => true },

  messages: {
    CONNECT_SOURCE: message(z.object({}), {
      guard: (_state, _payload, ctx) => ctx.callerType === "service",
      handler: (state, _payload, { link }) => {
        link("source", state.sourceId);
        return state;
      },
    }),
  },

  views: {
    viewer: view.shared(GameView, (state) => state.currentView),
  },
});
```

> **Note:** Init-time link resolution (`await link()` in init) is planned but not yet implemented. For now, use a setup message (`CONNECT_SOURCE`) to establish links after init. The relay spawns, receives the message, and `onUpdate` populates the view.

## Re-projecting Per-Client Views

If clients need role-specific views, the relay can re-project from the superset view it receives from the source. The source resolves the relay as a `service` role, so the relay gets all fields. The relay then defines its own roles and projects accordingly:

```typescript
const RelayContract = defineActor("relay", {
  input: z.object({ sourceId: z.string() }),

  links: {
    source: link(GameContract, {
      onUpdate: (state, view) => ({ ...state, currentView: view }),
    }),
  },

  init: (input) => ({
    sourceId: input.sourceId,
    currentView: null as LinkedView<GameContract> | null,
  }),

  messages: {
    CONNECT_SOURCE: message(z.object({}), {
      guard: (_state, _payload, ctx) => ctx.callerType === "service",
      handler: (state, _payload, { link }) => {
        link("source", state.sourceId);
        return state;
      },
    }),
  },

  roles: {
    admin: (state, caller) => state.currentView?.settings.adminIds.includes(caller) ?? false,
    viewer: () => true,
  },

  views: {
    admin: view.shared(AdminView, (state) => ({
      players: state.currentView?.players ?? [],
      settings: state.currentView?.settings ?? {},
      scores: state.currentView?.scores ?? {},
      status: state.currentView?.status ?? "waiting",
    })),
    viewer: view.shared(ViewerView, (state) => ({
      players: state.currentView?.players ?? [],
      status: state.currentView?.status ?? "waiting",
    })),
  },
});
```

The relay's role resolution runs independently of the source's. The relay decides what each of _its_ clients can see.

## Client Routing

The Worker's `fetch` handler assigns clients to relays instead of connecting them directly to the source:

```typescript
export default {
  async fetch(request, env, ctx) {
    // Simple modulo routing — assign to relay based on hash
    const callerId = getCallerId(request);
    const relayIndex = hashToIndex(callerId, RELAY_COUNT);
    const relayId = `relay-${gameId}-${relayIndex}`;

    const relay = env.RELAY.get(env.RELAY.idFromName(relayId));
    // Forward WebSocket upgrade to relay instead of source
  },
};
```

Consistent hashing ensures the same client always routes to the same relay, preserving connection affinity across reconnects.

## When to Use

| Connections | Pattern |
|------------|---------|
| < 1,000 | Direct — single actor handles all clients |
| 1,000 - 100,000 | Relay — source + N relay actors |
| > 100,000 | Multiple relay tiers or external pub/sub |

Most applications never need relays. Start with direct connections and add relays when `broadcastViews()` latency becomes measurable.

## Limitations

- **Added latency.** Every view update travels source → relay → client instead of source → client. For a game running at 60Hz updates, this adds one hop of DO-to-DO RPC latency (~1-5ms intra-colo).
- **Brief staleness.** Relay views may lag behind the source by one update cycle. Clients on different relays can see slightly different snapshots at the same instant.
- **Cost.** Each relay is a separate Durable Object with its own storage and compute billing. 100 relays = 100x the DO fixed costs, though per-request costs are spread across them.
- **Messages go to the source.** Clients send messages through the relay, but the relay forwards them to the source for processing. The relay is read-only — it never mutates game state.

## Related

- [Actor-to-Actor Communication](/recipes/actor-to-actor/) — the `link()` API that relays use to subscribe to the source
- [Views](/concepts/views/) — per-role view projections and binary encoding
