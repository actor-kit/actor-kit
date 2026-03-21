# 019: Library-Agnostic Actor Logic

**Priority**: P0
**Status**: Proposal
**ADR**: [2026-03-20-library-agnostic-actor-logic](../adrs/2026-03-20-library-agnostic-actor-logic.md)
**Affects**: All packages

## Problem

Actor-kit is hardcoded to XState v5. Users must define all actor behavior as XState machines, even for simple use cases. XState-specific types leak into client-side packages. Users can't use their preferred state management library.

## Proposed Solution

Define an `ActorLogic` interface and provide adapters for popular libraries.

### Phase 1: Core Interface + defineLogic

Create `@actor-kit/core` with the `ActorLogic` interface and `defineLogic()` helper.

```typescript
import { defineLogic, createDurableActor } from "@actor-kit/core";
import { z } from "zod";

// Define actor behavior — no external library needed
const counterLogic = defineLogic({
  create: (input: { initialCount?: number }) => ({
    count: input.initialCount ?? 0,
    accessCounts: {} as Record<string, number>,
  }),

  transition: (state, event, { caller, env }) => {
    switch (event.type) {
      case "INCREMENT":
        return {
          ...state,
          count: state.count + 1,
          accessCounts: {
            ...state.accessCounts,
            [caller.id]: (state.accessCounts[caller.id] ?? 0) + 1,
          },
        };
      case "RESET":
        if (caller.type !== "service") return state;
        return { ...state, count: 0 };
      default:
        return state;
    }
  },

  getView: (state, caller) => ({
    count: state.count,
    myAccessCount: state.accessCounts[caller.id] ?? 0,
  }),

  serialize: (state) => state,
  restore: (s) => s,
});

// Wire into a Durable Object
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
  input: z.object({ initialCount: z.number().optional() }),
  persisted: true,
});
```

**Deliverables**:
- `@actor-kit/core` package with `ActorLogic` interface, `defineLogic()`, `createDurableActor()`, `Caller` type
- Event validation via Zod schemas (client/service split)
- Persistence with `serialize`/`restore`/`version`/`migrate`
- Lifecycle hooks: `onConnect`, `onDisconnect`, `onResume`

### Phase 2: Update Client Packages

Make `@actor-kit/browser` and `@actor-kit/react` library-agnostic.

**Before** (XState-coupled):
```typescript
import type { CallerSnapshotFrom, ClientEventFrom } from "@actor-kit/types";
type Snapshot = CallerSnapshotFrom<TodoMachine>;

const client = createActorKitClient<TodoMachine>({ ... });
client.getState().public.todos; // inferred from XState machine
```

**After** (library-agnostic):
```typescript
// TView = what getView returns, TEvent = client events
type TodoView = { todos: Todo[]; isOwner: boolean };
type TodoEvent = { type: "ADD_TODO"; text: string } | { type: "TOGGLE"; id: string };

const client = createActorKitClient<TodoView, TodoEvent>({ ... });
client.getState().todos; // TView directly — no public/private wrapper
```

**Deliverables**:
- `@actor-kit/browser`: `ActorKitClient<TView, TEvent>` — no XState dependency
- `@actor-kit/react`: `createActorKitContext<TView, TEvent>` — no XState dependency
- `@actor-kit/test`: Updated mock client and transition helper
- Remove `@actor-kit/types` (absorbed into `@actor-kit/core`)

### Phase 3: XState Adapter

Preserve full XState support via adapter.

```typescript
import { fromXStateMachine } from "@actor-kit/xstate";

const logic = fromXStateMachine(todoMachine, {
  getView: (snapshot, caller) => ({
    todos: snapshot.context.todos,
    isOwner: snapshot.context.ownerId === caller.id,
  }),
});

export const Todo = createDurableActor({
  logic,
  events: { client: TodoClientSchema, service: TodoServiceSchema },
  input: TodoInputSchema,
  persisted: true,
});
```

**Deliverables**:
- `@actor-kit/xstate` package
- `fromXStateMachine(machine, opts)` → `ActorLogic`
- Augments events with `caller`/`env` (like today)
- Uses `xstate-migrate` for automatic snapshot migration
- Supports invoked actors, guards, parallel states — full XState feature set

### Phase 4: @xstate/store Adapter

```typescript
import { fromXStateStore } from "@actor-kit/xstate-store";

const logic = fromXStateStore({
  context: { count: 0 },
  on: {
    inc: (ctx, event: { caller: Caller }) => ({
      ...ctx,
      count: ctx.count + 1,
      lastUpdatedBy: event.caller.id,
    }),
  },
}, {
  getView: (state, caller) => ({ count: state.count }),
});
```

**Deliverables**:
- `@actor-kit/xstate-store` package
- `fromXStateStore(storeDef, opts)` → `ActorLogic`
- Augments events with `caller`/`env` before `store.send()`
- Bridges `enqueue.effect()` for side effects
- Upgrade path to XState via `fromStore()` when complexity grows

### Phase 5: Redux Adapter

```typescript
import { fromRedux } from "@actor-kit/redux";

const logic = fromRedux(counterReducer, {
  create: (input) => counterReducer(undefined, { type: "@@INIT", ...input }),
  getView: (state, caller) => ({ count: state.count }),
  serialize: (state) => state,
  restore: (s) => s,
});
```

**Deliverables**:
- `@actor-kit/redux` package
- `fromRedux(reducer, opts)` → `ActorLogic`
- Augments actions with `caller`/`env`

### Phase 6: E2E Examples

Update example apps and create new ones demonstrating each adapter:

- `examples/xstate-todo` — XState adapter (port existing NextJS/TanStack examples)
- `examples/xstate-store-todo` — @xstate/store adapter
- `examples/redux-counter` — Redux adapter
- `examples/plain-counter` — defineLogic, no library (port Hono example)

Each example includes workers integration tests.

## Migration Path

For existing actor-kit users:

1. Install `@actor-kit/xstate` adapter
2. Replace `createMachineServer({ machine, schemas })` with:
   ```typescript
   createDurableActor({
     logic: fromXStateMachine(machine, { getView }),
     events: { client: schemas.clientEvent, service: schemas.serviceEvent },
     input: schemas.inputProps,
   })
   ```
3. Replace `CallerSnapshotFrom<TMachine>` with your `TView` type
4. Update client code: `state.public.todos` → `state.todos` (view is flat, no public/private wrapper)

## Package Mapping

| Before | After |
|--------|-------|
| `@actor-kit/types` | `@actor-kit/core` (ActorLogic, Caller, etc.) |
| `@actor-kit/worker` | `@actor-kit/core` (createDurableActor) + `@actor-kit/xstate` (adapter) |
| `@actor-kit/browser` | `@actor-kit/browser` (updated types: TView/TEvent instead of TMachine) |
| `@actor-kit/react` | `@actor-kit/react` (updated types) |
| `@actor-kit/server` | `@actor-kit/server` (unchanged) |
| `@actor-kit/test` | `@actor-kit/test` (updated for ActorLogic) |
| `@actor-kit/storybook` | `@actor-kit/storybook` (updated for ActorLogic) |

## Test Plan

### Per phase:

1. **Core**: Unit tests for `defineLogic`, `createDurableActor`, event validation, persistence, lifecycle hooks. Workers integration tests for DO behavior.
2. **Client**: Existing browser/react/test package tests updated for new types. Verify wire protocol unchanged.
3. **XState adapter**: Port all existing XState-based tests. Verify migration from current API produces identical behavior.
4. **@xstate/store adapter**: New tests for store-based actors, effect enqueuing, caller access.
5. **Redux adapter**: New tests for reducer-based actors.
6. **E2E**: Playwright tests for each example app. Storybook play function tests.

### Regression:
- Existing integration tests (Miniflare sync, WebSocket protocol) must pass with XState adapter
- Existing e2e tests (NextJS, TanStack Start) must pass after migration
- Wire protocol (JSON Patch diffs) unchanged — client doesn't know which library the server uses

## Open Questions

1. **Should `@actor-kit/worker` continue to exist as a re-export of `createDurableActor` for backwards compat?** Leaning no — clean break.
2. **Should `createActorKitRouter` be deprecated in favor of framework-native routing (Hono example pattern)?** Leaning yes — the Hono example proved the primitives compose better.
3. **How do adapters handle the `enqueue` pattern for libraries that don't support it?** The `defineLogic` helper could provide its own `enqueue` implementation, or effects are just handled outside the transition.
