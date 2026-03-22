# Phase 6: Advanced — Specification

## Goal

Advanced features: optional finite states, async state entry, raw binary output escape hatch, and actor supervision.

## Prerequisites

Phases 1-5 complete.

## Deliverables

### 1. Finite states

```typescript
export const Auction = actor("auction", {
  init: (input) => ({
    item: input.item,
    bids: [],
    winner: null,
    state: "accepting_bids" as const,
  }),

  states: {
    accepting_bids: {
      messages: {
        bidder: {
          BID: (state, { amount }, { caller }) =>
            produce(state, d => { d.bids.push({ caller, amount }); }),
        },
      },
      after: {
        "1 hour": "evaluating",
      },
    },
    evaluating: {
      invoke: async (state, { env }) => {
        const winner = state.bids.reduce((a, b) => a.amount > b.amount ? a : b);
        await env.PAYMENT_QUEUE.send({ winner: winner.caller, amount: winner.amount });
        return produce(state, d => {
          d.winner = winner.caller;
          d.state = "closed";
        });
      },
    },
    closed: {
      messages: {}, // no messages accepted
    },
  },

  roles: { ... },
  views: { ... },
});
```

Requirements:
- `states` is optional. If absent, all messages are always valid.
- When `states` is present, messages are only valid in the current state.
- `after` triggers state transitions via DO Alarms.
- `invoke` runs async work on state entry. Returns new state.
- State value lives in the actor's state (user-defined field, typically `state`).
- Framework tracks current state and constrains messages accordingly.

### 2. `output()` escape hatch

```typescript
export const Zone = actor("zone", {
  // ...

  output: (state, caller, role, send) => {
    if (role === "player") {
      const nearby = state.spatialGrid.query(state.positions[caller], 120);
      send.binary(packPositions(nearby));
    }
    send.json({ weather: state.weather });
  },
});
```

Requirements:
- `output()` replaces the normal view sync for callers where it's defined
- Called after every transition (same as view computation)
- `send.binary(Uint8Array)` sends a raw binary frame
- `send.json(object)` sends a JSON frame
- Can send multiple frames per transition
- If both `views` and `output` are defined, `output` takes priority for callers where it produces output
- Used for MMO position streaming and other high-frequency binary data

### 3. Actor supervision

```typescript
export const GameServer = actor("game-server", {
  // ...

  supervise: {
    "zone": {
      onCrash: (state, { actorId, error }) =>
        produce(state, d => {
          d.zoneStatus[actorId] = "crashed";
          d.pendingRestart.push(actorId);
        }),
      onRestart: (state, { actorId }) =>
        produce(state, d => {
          d.zoneStatus[actorId] = "running";
        }),
    },
  },
});
```

Requirements:
- An actor can supervise other actors of specific types
- `onCrash` fires when a supervised actor's DO crashes
- `onRestart` fires when it recovers
- Supervision is opt-in and one-way (supervisor watches, doesn't control lifecycle)
- Implemented via DO Alarm polling or CF analytics API (TBD — research needed)
- This is the most speculative feature — may be descoped

## Acceptance criteria

1. Finite states constrain which messages are valid
2. `after` transitions between states via DO Alarm
3. `invoke` runs async work on state entry
4. `output()` sends raw binary frames to clients
5. Supervision detects crashed actors and notifies supervisor
