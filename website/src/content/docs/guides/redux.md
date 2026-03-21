---
title: "Using Redux"
description: Build actors with Redux-style reducers using the fromRedux adapter.
---

This guide shows how to use the Redux adapter with Actor Kit. If you already know Redux, you can use the same `(state, action) => state` pattern you're familiar with.

> **Source code**: [examples/hono-redux-counter](https://github.com/actor-kit/actor-kit/tree/main/examples/hono-redux-counter)

## Define your actor logic

```typescript
import { fromRedux } from "@actor-kit/redux";
import { createDurableActor } from "@actor-kit/core";
import { z } from "zod";
import type { Caller } from "@actor-kit/core";

type CounterState = {
  count: number;
  accessCounts: Record<string, number>;
};

type CounterAction =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

// Standard Redux reducer — action includes caller and env
function counterReducer(
  state: CounterState | undefined,
  action: CounterAction & { caller: Caller; env: { ACTOR_KIT_SECRET: string } }
): CounterState {
  if (!state) return { count: 0, accessCounts: {} };

  switch (action.type) {
    case "INCREMENT":
      return {
        ...state,
        count: state.count + 1,
        accessCounts: {
          ...state.accessCounts,
          [action.caller.id]: (state.accessCounts[action.caller.id] ?? 0) + 1,
        },
      };
    case "DECREMENT":
      return { ...state, count: state.count - 1 };
    case "RESET":
      if (action.caller.type !== "service") return state;
      return { ...state, count: 0 };
    default:
      return state;
  }
}

const counterLogic = fromRedux(counterReducer, {
  create: () => ({ count: 0, accessCounts: {} }),
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

- **Standard Redux reducer** — `(state | undefined, action) => state`
- **`action.caller`** is available in the reducer — Actor Kit augments actions before they reach Redux
- **You provide `create` separately** — Redux reducers handle undefined state, but Actor Kit needs an explicit factory for typed input
- **Same `getView` pattern** — caller-scoped projections work identically

### When to use Redux

- Your team already knows Redux patterns
- You want to reuse existing Redux middleware or devtools
- You prefer switch/case reducers over declarative handlers

## Routing, WebSocket, and client

The server setup is identical to the [plain counter guide](/guides/hono-plain-counter/). The only difference is how you define the logic.

## Next steps

- [Plain counter guide](/guides/hono-plain-counter/) for the full routing + WebSocket setup
- [Using @xstate/store](/guides/xstate-store/) for a lighter declarative approach
- [Using XState](/guides/xstate/) for complex statecharts
