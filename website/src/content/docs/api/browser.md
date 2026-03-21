---
title: "@actor-kit/browser"
description: WebSocket client for connecting to Actor Kit servers from the browser.
---

The browser package provides the client that manages WebSocket connections, state syncing, and reconnection.

## `createActorKitClient<TView, TEvent>(props)`

Creates a client instance for communicating with an actor. The generic parameters are:

- `TView` — your view type (the return type of `getView()` in your actor logic)
- `TEvent` — the client event union type

### Parameters

- `host` — Worker host URL
- `actorType` — Actor type string (e.g., `"todo"`)
- `actorId` — Unique actor instance ID
- `checksum` — Initial state checksum (from SSR fetch)
- `accessToken` — JWT access token
- `initialSnapshot` — Initial view snapshot (from SSR fetch)

### Returns

An `ActorKitClient<TView, TEvent>` with the following methods:

### `client.connect()`

Establishes a WebSocket connection to the actor server.

### `client.disconnect()`

Closes the WebSocket connection.

### `client.send(event)`

Sends a client event to the actor. The event must match your `TEvent` type.

```typescript
client.send({ type: "ADD_TODO", text: "Buy milk" });
```

### `client.getState()`

Returns the current view snapshot (`TView`).

### `client.subscribe(listener)`

Registers a listener that's called on every state change. Returns an unsubscribe function.

```typescript
const unsubscribe = client.subscribe((view) => {
  console.log("New view:", view);
});
```

### `client.waitFor(predicate, timeoutMs?)`

Returns a Promise that resolves when the predicate returns `true` for the current view. Optional timeout in milliseconds.

```typescript
await client.waitFor((view) => view.todos.length > 0);

await client.waitFor(
  (view) => view.todos.length > 0,
  10000
);
```

### `client.trigger`

Typed proxy for `send` — provides autocomplete for event types:

```typescript
client.trigger.ADD_TODO({ text: "Buy milk" });
client.trigger.TOGGLE_TODO({ id: "todo-1" });
```

### `client.select(selector)`

Select derived state from the current view:

```typescript
const count = client.select((v) => v.todos.length);
```

### `client.onStateChange(listener)`

Register a callback for state changes. Similar to `subscribe` but receives the full view:

```typescript
client.onStateChange((view) => {
  console.log("View:", view);
});
```

### `client.onError(listener)`

Register a callback for connection errors:

```typescript
client.onError((error) => {
  console.error("Connection error:", error);
});
```

## Full example

```typescript
import { createActorKitClient } from "@actor-kit/browser";

type TodoView = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  isOwner: boolean;
  lastSync: number | null;
};

type TodoClientEvent =
  | { type: "ADD_TODO"; text: string }
  | { type: "TOGGLE_TODO"; id: string };

const client = createActorKitClient<TodoView, TodoClientEvent>({
  host: "your-worker.workers.dev",
  actorType: "todo",
  actorId: "todo-123",
  checksum: "initial-checksum",
  accessToken: "your-access-token",
  initialSnapshot: {
    ownerId: "user-1",
    todos: [],
    isOwner: true,
    lastSync: null,
  },
});

await client.connect();
client.send({ type: "ADD_TODO", text: "Buy milk" });
```

> In most cases, you'll use `@actor-kit/react` instead of the browser client directly. The React provider handles connection lifecycle automatically.
