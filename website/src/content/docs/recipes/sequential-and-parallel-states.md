---
title: Sequential and Parallel States
description: How to model multi-phase workflows and independent state regions.
---

By default, all messages defined in the `messages` block are always valid (gated only by role and guard). For actors with distinct phases or independent concerns, Actor Kit supports two additional modes: sequential states and parallel states.

## Mode 1: No states (default)

The simplest mode. All messages are always available to their respective roles:

```typescript
export const Counter = actor<Env>("counter", {
  input: z.object({}),
  init: () => ({ count: 0 }),
  roles: { user: () => true },
  messages: {
    user: { INCREMENT: increment, DECREMENT: decrement },
  },
  views: { user: view(CounterView, (state) => ({ count: state.count })) },
});
```

No `initial` or `states` field — messages are valid in any state.

## Mode 2: Sequential states

One active state at a time. Each state defines its own messages per role. Use this for workflows with distinct phases where different actions are available in each phase.

**Example: an order that moves through phases**

```typescript
export const Order = actor<Env>("order", {
  input: z.object({ items: z.array(z.string()) }),
  init: (input) => ({
    items: input.items,
    shippingAddress: null as string | null,
    trackingNumber: null as string | null,
  }),

  roles: {
    owner: (state, caller, { callerType }) => callerType === "user",
    fulfillment: (_state, _caller, { callerType }) => callerType === "service",
  },

  initial: "pending",

  states: {
    pending: {
      messages: {
        owner: {
          SET_ADDRESS: setAddress,
          CONFIRM: confirmOrder,
        },
        fulfillment: {},
      },
    },
    confirmed: {
      messages: {
        owner: {},  // Owner can't change anything after confirming
        fulfillment: {
          SHIP: shipOrder,
        },
      },
    },
    shipped: {
      messages: {
        owner: {},
        fulfillment: {
          DELIVER: markDelivered,
        },
      },
    },
    delivered: {
      messages: {
        owner: {},
        fulfillment: {},
      },
    },
    cancelled: {
      messages: {
        owner: {},
        fulfillment: {},
      },
    },
  },

  views: {
    owner: view(OrderView, (state) => ({
      items: state.items,
      address: state.shippingAddress ?? "",
      tracking: state.trackingNumber ?? "",
    })),
    fulfillment: view(FulfillmentView, (state) => ({
      items: state.items,
      address: state.shippingAddress ?? "",
    })),
  },
});
```

Key points:
- **`initial`** sets the starting state (`"pending"`)
- **`states`** replaces the top-level `messages` — each state defines which messages each role can send
- **Empty `{}`** means the role is read-only in that state

### State transitions

To move between sequential states, include a `__actorState` field in the returned state. The framework reads this field and updates the active state tracker:

```typescript
const confirmOrder = message(z.object({}), (state) => ({
  ...state,
  __actorState: "confirmed",  // Advances from "pending" → "confirmed"
}));

const shipOrder = message(
  z.object({ trackingNumber: z.string() }),
  (state, { trackingNumber }) => ({
    ...state,
    trackingNumber,
    __actorState: "shipped",  // Advances from "confirmed" → "shipped"
  }),
);

const markDelivered = message(z.object({}), (state) => ({
  ...state,
  __actorState: "delivered",
}));
```

The `__actorState` field is consumed by the framework and does not persist in your state. After the transition, messages defined in the new state become available and messages from the previous state are no longer valid.

### Timers with sequential states

Durable timers (`after`) are defined at the **top level** of the actor, not inside individual states. Use a guard to restrict the timer to a specific state:

```typescript
export const Order = actor<Env>("order", {
  // ...states as above...

  after: {
    "48 hours": message(z.object({}), {
      guard: (state) => state.__actorState === "confirmed",  // Only fire in "confirmed"
      handler: (state) => ({ ...state, __actorState: "cancelled" }),
    }),
  },
});
```

## Mode 3: Parallel states

Multiple independent state regions active simultaneously. Messages from all active regions are merged — a message is valid if it's valid in any active region.

Parallel states currently support **message routing only**. The framework merges valid messages from all active regions, so different concerns can define different message sets independently. However, advancing a region's active state (analogous to `__actorState` for sequential states) is not yet supported.

**Example: a game lobby with independent message groups**

```typescript
export const Lobby = actor<Env>("lobby", {
  input: z.object({ hostId: z.string() }),
  init: (input) => ({
    hostId: input.hostId,
    players: [] as string[],
    readyPlayers: [] as string[],
    map: "default",
    difficulty: "normal" as "easy" | "normal" | "hard",
    started: false,
    settingsLocked: false,
  }),

  roles: {
    host: (state, caller) => caller === state.hostId,
    player: (state, caller) => state.players.includes(caller),
  },

  states: {
    parallel: true,
    regions: {
      readiness: {
        initial: "waiting",
        states: {
          waiting: {
            messages: {
              host: { START_GAME: startGame },
              player: { READY: toggleReady },
            },
          },
        },
      },
      settings: {
        initial: "open",
        states: {
          open: {
            messages: {
              host: {
                SET_MAP: setMap,
                SET_DIFFICULTY: setDifficulty,
              },
              player: {},
            },
          },
        },
      },
    },
  },

  views: {
    host: view(HostView, (state) => ({ /* ... */ })),
    player: view(PlayerView, (state) => ({ /* ... */ })),
  },
});
```

In this example, `READY` (from the `readiness` region) and `SET_MAP` (from the `settings` region) are both valid simultaneously because both regions are active. This lets you organize message handlers by concern without one blocking the other.

Since parallel region transitions aren't supported yet, use guards on your message handlers to control behavior (e.g., reject `SET_MAP` when `state.settingsLocked` is true).

## Which mode to use

| Mode | When | Example |
|------|------|---------|
| No states | All messages always valid | Counter, chat room |
| Sequential | Distinct phases, different actions per phase | Order workflow, auction (open → closed) |
| Parallel | Independent message groups that are all valid together | Game lobby (readiness + settings) |
