---
title: "Using @xstate/store"
description: Build actors with @xstate/store — a lightweight event-driven store with effects and persistence.
---

This guide shows how to use the `@xstate/store` adapter with Actor Kit. It's a good middle ground between plain reducers and full XState — you get declarative event handlers, effects via `enqueue`, and an upgrade path to XState when you need it.

> **Source code**: [examples/hono-xstate-store-counter](https://github.com/actor-kit/actor-kit/tree/main/examples/hono-xstate-store-counter)

## Define your actor logic

```typescript
import { fromXStateStore } from "@actor-kit/xstate-store";
import { createDurableActor } from "@actor-kit/core";
import { z } from "zod";

const counterLogic = fromXStateStore({
  context: { count: 0, accessCounts: {} as Record<string, number> },
  on: {
    INCREMENT: (ctx, event: { caller: { id: string } }) => ({
      ...ctx,
      count: ctx.count + 1,
      accessCounts: {
        ...ctx.accessCounts,
        [event.caller.id]: (ctx.accessCounts[event.caller.id] ?? 0) + 1,
      },
    }),
    DECREMENT: (ctx) => ({ ...ctx, count: ctx.count - 1 }),
    RESET: (ctx, event: { caller: { type: string } }) => {
      if (event.caller.type !== "service") return ctx;
      return { ...ctx, count: 0 };
    },
  },
}, {
  getView: (state, caller) => ({
    count: state.count,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),
});

export const Counter = createDurableActor({
  logic: counterLogic,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
      z.object({ type: z.literal("DECREMENT") }),
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

- **Declarative `on` handlers** — each event type is a key, not a switch case
- **`event.caller`** is available in every handler — Actor Kit augments events before they reach the store
- **Same `getView` pattern** — you provide a projection function for caller-scoped views

### When to use @xstate/store

- You want declarative event handlers without XState's full statechart model
- You plan to use `@xstate/store`'s features: effects via `enqueue`, selectors, undo/redo, persist
- You might upgrade to XState later — `fromStore()` bridges directly to `createActor()`

## Routing, WebSocket, and client

The server setup (Hono routes, WebSocket upgrade, React client) is identical to the [plain counter guide](/guides/hono-plain-counter/). The only difference is how you define the logic — everything downstream is the same.

## Next steps

- [Plain counter guide](/guides/hono-plain-counter/) for the full routing + WebSocket setup
- [Using XState](/guides/xstate/) for complex statecharts
- [@xstate/store docs](https://stately.ai/docs/xstate-store) for effects, selectors, and undo/redo
