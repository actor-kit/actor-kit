---
title: "@actor-kit/core"
description: Core package for defining actor logic and running it in Cloudflare Durable Objects.
---

The core package provides the `ActorLogic` interface, `defineLogic()` helper, and `createDurableActor()` factory for wiring actors into Durable Objects.

## `defineLogic(config)`

The simplest way to create actor logic using a plain reducer. No external state library required.

### Parameters

- `events` — Zod schemas for runtime validation:
  - `client` — Schema for browser client events
  - `service` — Schema for backend service events
- `context` — Initial context factory: `(input) => TState`
- `actions` — Object mapping event types to reducer functions: `(state, event, { caller }) => TState`
- `getView` — View projection: `(state, caller) => TView`

### Returns

An `ActorLogic` object ready to pass to `createDurableActor()`.

### Example

```typescript
import { defineLogic } from "@actor-kit/core";
import { z } from "zod";

const TodoClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_TODO"), text: z.string() }),
  z.object({ type: z.literal("TOGGLE_TODO"), id: z.string() }),
]);

const TodoServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SYNC_COMPLETE"), timestamp: z.number() }),
]);

const todoLogic = defineLogic({
  events: {
    client: TodoClientEventSchema,
    service: TodoServiceEventSchema,
  },
  context: (input) => ({
    ownerId: input.caller.id,
    todos: [] as Array<{ id: string; text: string; completed: boolean }>,
    lastSync: null as number | null,
  }),
  actions: {
    ADD_TODO: (state, event) => ({
      ...state,
      todos: [
        ...state.todos,
        { id: crypto.randomUUID(), text: event.text, completed: false },
      ],
    }),
    TOGGLE_TODO: (state, event) => ({
      ...state,
      todos: state.todos.map((t) =>
        t.id === event.id ? { ...t, completed: !t.completed } : t
      ),
    }),
    SYNC_COMPLETE: (state, event) => ({
      ...state,
      lastSync: event.timestamp,
    }),
  },
  getView: (state, caller) => ({
    ownerId: state.ownerId,
    todos: state.todos,
    lastSync: state.lastSync,
    isOwner: caller.id === state.ownerId,
  }),
});
```

## `createDurableActor(config)`

Creates a Durable Object class that runs your actor logic with WebSocket support, persistence, and access control.

### Parameters

- `logic` — An `ActorLogic` object (from `defineLogic()`, `fromXStateMachine()`, `fromXStateStore()`, or `fromRedux()`)
- `options` — Configuration:
  - `persisted` — Whether to persist state to DO storage (default: `false`)

### Returns

A Durable Object class that you export from your Worker.

### Example

```typescript
import { createDurableActor } from "@actor-kit/core";
import { todoLogic } from "./todo.logic";

export const Todo = createDurableActor({
  logic: todoLogic,
  options: {
    persisted: true,
  },
});

export type TodoServer = InstanceType<typeof Todo>;
export default Todo;
```

## `createAccessToken(props)`

Creates a signed JWT for authenticating clients to an actor.

### Parameters

- `signingKey` — Secret key for signing
- `actorId` — Target actor ID
- `actorType` — Target actor type string
- `callerId` — Caller's ID
- `callerType` — `"client"` or `"service"`

### Returns

A signed JWT string.

## `getCallerFromRequest(request, env)`

Extracts and validates the caller identity from an incoming request's JWT.

### Parameters

- `request` — The incoming `Request` object
- `env` — Worker environment (must include `ACTOR_KIT_SECRET`)

### Returns

A `Caller` object with `type` and `id`.

## Routing

`createActorKitRouter` from the old `@actor-kit/worker` package is deprecated. Use framework-native routing instead. Here is an example with [Hono](https://hono.dev/):

```typescript
import { Hono } from "hono";
import { Todo } from "./todo.server";

interface Env {
  TODO: DurableObjectNamespace<InstanceType<typeof Todo>>;
  ACTOR_KIT_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

app.all("/api/todo/:id/*", async (c) => {
  const id = c.env.TODO.idFromName(c.req.param("id"));
  const stub = c.env.TODO.get(id);
  return stub.fetch(c.req.raw);
});

export { Todo };
export default app;
```

## `ActorLogic` interface

The interface that all actor logic must implement. You rarely implement this directly — use `defineLogic()` or an adapter instead.

```typescript
interface ActorLogic<TState, TEvent, TView, TInput> {
  /** Zod schemas for event validation */
  schemas: {
    clientEvent: ZodSchema<TClientEvent>;
    serviceEvent: ZodSchema<TServiceEvent>;
  };

  /** Create initial state from input */
  getInitialState(input: TInput): TState;

  /** Process an event, returning the next state */
  transition(state: TState, event: TEvent): TState;

  /** Project caller-scoped view from full state */
  getView(state: TState, caller: Caller): TView;

  /** Serialize state for persistence */
  serialize(state: TState): unknown;

  /** Restore state from persisted data */
  deserialize(data: unknown): TState;
}
```

## XState adapter

Use `fromXStateMachine()` from `@actor-kit/xstate` to wrap an XState v5 machine:

```typescript
import { fromXStateMachine } from "@actor-kit/xstate";
import { createDurableActor } from "@actor-kit/core";
import { todoMachine } from "./todo.machine";

const todoLogic = fromXStateMachine({
  machine: todoMachine,
  schemas: {
    clientEvent: TodoClientEventSchema,
    serviceEvent: TodoServiceEventSchema,
  },
  getView: (snapshot, caller) => ({
    todos: snapshot.context.todos,
    isOwner: caller.id === snapshot.context.ownerId,
    state: snapshot.value,
  }),
});

export const Todo = createDurableActor({
  logic: todoLogic,
  options: { persisted: true },
});
```

## @xstate/store adapter

Use `fromXStateStore()` from `@actor-kit/xstate-store`:

```typescript
import { fromXStateStore } from "@actor-kit/xstate-store";
import { createDurableActor } from "@actor-kit/core";
import { todoStore } from "./todo.store";

const todoLogic = fromXStateStore({
  store: todoStore,
  schemas: {
    clientEvent: TodoClientEventSchema,
    serviceEvent: TodoServiceEventSchema,
  },
  getView: (snapshot, caller) => ({
    todos: snapshot.context.todos,
    isOwner: caller.id === snapshot.context.ownerId,
  }),
});

export const Todo = createDurableActor({
  logic: todoLogic,
  options: { persisted: true },
});
```

## Redux adapter

Use `fromRedux()` from `@actor-kit/redux`:

```typescript
import { fromRedux } from "@actor-kit/redux";
import { createDurableActor } from "@actor-kit/core";
import { todoReducer } from "./todo.reducer";

const todoLogic = fromRedux({
  reducer: todoReducer,
  schemas: {
    clientEvent: TodoClientEventSchema,
    serviceEvent: TodoServiceEventSchema,
  },
  getView: (state, caller) => ({
    todos: state.todos,
    isOwner: caller.id === state.ownerId,
  }),
});

export const Todo = createDurableActor({
  logic: todoLogic,
  options: { persisted: true },
});
```
