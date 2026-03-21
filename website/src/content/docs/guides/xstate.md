---
title: "Using XState"
description: Build actors with XState v5 state machines — guards, parallel states, invoked actors.
---

This guide shows how to use the XState adapter with Actor Kit. Use XState when you need statecharts — hierarchical/parallel states, guards, delayed transitions, invoked actors, and visualization with Stately Studio.

> **Source code**: [examples/nextjs-xstate-todo](https://github.com/actor-kit/actor-kit/tree/main/examples/nextjs-xstate-todo) and [examples/tanstack-start-xstate-todo](https://github.com/actor-kit/actor-kit/tree/main/examples/tanstack-start-xstate-todo)

## Define your actor logic

```typescript
import { fromXStateMachine } from "@actor-kit/xstate";
import { createDurableActor } from "@actor-kit/core";
import { assign, setup } from "xstate";
import { z } from "zod";

// Standard XState v5 machine
const counterMachine = setup({
  types: {
    context: {} as {
      count: number;
      lastUpdatedBy: string | null;
      accessCounts: Record<string, number>;
    },
    events: {} as
      | { type: "INCREMENT"; caller: { id: string; type: string }; env: Record<string, unknown> }
      | { type: "RESET"; caller: { id: string; type: string }; env: Record<string, unknown> },
  },
  guards: {
    isService: ({ event }) => event.caller.type === "service",
  },
  actions: {
    increment: assign(({ context, event }) => ({
      count: context.count + 1,
      lastUpdatedBy: event.caller.id,
      accessCounts: {
        ...context.accessCounts,
        [event.caller.id]: (context.accessCounts[event.caller.id] ?? 0) + 1,
      },
    })),
    reset: assign(() => ({
      count: 0,
      lastUpdatedBy: null,
    })),
  },
}).createMachine({
  id: "counter",
  initial: "active",
  context: { count: 0, lastUpdatedBy: null, accessCounts: {} },
  states: {
    active: {
      on: {
        INCREMENT: { actions: "increment" },
        RESET: { guard: "isService", actions: "reset" },
      },
    },
  },
});

// Wrap the XState machine with the adapter
const counterLogic = fromXStateMachine(counterMachine, {
  getView: (snapshot, caller) => ({
    count: snapshot.context.count,
    lastUpdatedBy: snapshot.context.lastUpdatedBy,
    myAccessCount: snapshot.context.accessCounts[caller.id] ?? 0,
    state: snapshot.value, // XState state value (e.g., "active")
  }),
});

export const Counter = createDurableActor({
  logic: counterLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({ type: z.literal("RESET") }),
    ]),
  },
  input: z.object({}),
  persisted: true,
});
```

### How it differs from `defineLogic`

- **XState machine definition** — `setup().createMachine()` with typed context, events, guards, actions
- **Guards** — `isService` prevents unauthorized transitions at the machine level
- **`event.caller` and `event.env`** — Actor Kit augments events before they reach the machine (same as the old `BaseActorKitEvent` pattern)
- **`getView` receives XState's snapshot** — you can include `snapshot.value` (the current state name) in the view
- **Auto-migration** — `fromXStateMachine` uses `xstate-migrate` to automatically evolve persisted snapshots when the machine definition changes

### When to use XState

- You need **statecharts** — hierarchical states, parallel regions, history states
- You need **guards** that prevent invalid transitions
- You need **delayed transitions** or **invoked actors** (timers, API calls)
- You want to **visualize** your logic with [Stately Studio](https://stately.ai/studio)
- Your state logic is **complex enough** that a visual representation adds value

### XState event types

Actor Kit augments every event with `caller` and `env`. Your XState event types should include these:

```typescript
type MyEvent =
  | { type: "ADD_TODO"; text: string; caller: Caller; env: Env }
  | { type: "TOGGLE"; id: string; caller: Caller; env: Env };
```

This is the one extra step compared to `defineLogic` — XState needs the full event shape in its type system.

## Full-stack examples

The XState adapter works with any framework for routing. See:

- **[Next.js + XState todo app](https://github.com/actor-kit/actor-kit/tree/main/examples/nextjs-xstate-todo)** — SSR with React Server Components, Playwright E2E tests
- **[TanStack Start + XState todo app](https://github.com/actor-kit/actor-kit/tree/main/examples/tanstack-start-xstate-todo)** — file-based routing, server functions, Playwright E2E tests

## Next steps

- [Plain counter guide](/guides/hono-plain-counter/) for the simplest setup
- [Using @xstate/store](/guides/xstate-store/) for a lighter alternative
- [XState v5 docs](https://stately.ai/docs/xstate) for the full API
