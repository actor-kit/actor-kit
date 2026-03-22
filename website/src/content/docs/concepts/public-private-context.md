---
title: Caller-Scoped Views
description: How Actor Kit projects per-caller views from full state using getView().
---

Every Actor Kit actor defines a `getView(state, caller)` function that controls exactly what each connected client sees. This replaces the old fixed `public`/`private` context structure with a fully flexible projection.

## The pattern

```typescript
getView(state: TState, caller: Caller): TView
```

- **`state`** is the full, internal actor state — never sent to clients directly.
- **`caller`** identifies the connected client (`{ type, id }`).
- **`TView`** is the return type — you define this shape. It can be anything serializable.

Actor Kit calls `getView()` after every state transition, once per connected client. Each client may receive a **different view** of the same state.

## Example

```typescript
type TodoState = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  accessLog: Record<string, { count: number; lastViewedAt: number }>;
};

type TodoView = {
  todos: Array<{ id: string; text: string; completed: boolean }>;
  isOwner: boolean;
  myAccessCount: number;
};

const getView = (state: TodoState, caller: Caller): TodoView => ({
  todos: state.todos,
  isOwner: caller.id === state.ownerId,
  myAccessCount: state.accessLog[caller.id]?.count ?? 0,
});
```

In this example:
- All clients see the same `todos` list.
- Each client sees their own `isOwner` flag based on their identity.
- Each client sees only their own `myAccessCount` — never another caller's access data.

## What clients receive

Clients receive the output of `getView()` — your `TView` type. On the first connection, the full view is sent. On subsequent transitions, Actor Kit computes a JSON Patch diff between the old and new view and sends only the changes.

```typescript
// What client "user-123" receives:
{
  todos: [{ id: "1", text: "Buy milk", completed: false }],
  isOwner: true,
  myAccessCount: 3,
}

// What client "user-456" receives for the same state:
{
  todos: [{ id: "1", text: "Buy milk", completed: false }],
  isOwner: false,
  myAccessCount: 1,
}
```

This is the type you use with `useSelector` in React components and with `createActorKitClient<TView, TEvent>` in the browser client.

## Using with defineLogic()

Pass `getView` directly when defining logic:

```typescript
const todoLogic = defineLogic({
  events: { client: TodoClientEventSchema, service: TodoServiceEventSchema },
  context: (input) => ({
    ownerId: input.caller.id,
    todos: [],
    accessLog: {},
  }),
  actions: { /* ... */ },
  getView: (state, caller) => ({
    todos: state.todos,
    isOwner: caller.id === state.ownerId,
    myAccessCount: state.accessLog[caller.id]?.count ?? 0,
  }),
});
```

## Using with adapters

All adapters (`fromXStateMachine`, `fromXStateStore`, `fromRedux`) accept a `getView` function:

```typescript
const todoLogic = fromXStateMachine({
  machine: todoMachine,
  schemas: { /* ... */ },
  getView: (snapshot, caller) => ({
    todos: snapshot.context.todos,
    isOwner: caller.id === snapshot.context.ownerId,
    state: snapshot.value,
  }),
});
```

## Security guarantee

The `getView()` projection happens inside the Durable Object before any data leaves the server. There is no client-side filtering — the server simply never sends data that `getView()` does not include.

Different callers may receive **different JSON Patch diffs** for the same state transition, because their views differ.
