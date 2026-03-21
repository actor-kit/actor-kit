---
title: "@actor-kit/browser"
description: WebSocket client for connecting to Actor Kit servers from the browser.
---

The browser package provides the client that manages WebSocket connections, state syncing, and reconnection.

## `createActorKitClient<TMachine>(props)`

Creates a client instance for communicating with an actor.

### Parameters

- `host` — Worker host URL
- `actorType` — Actor type string (e.g., `"todo"`)
- `actorId` — Unique actor instance ID
- `checksum` — Initial state checksum (from SSR fetch)
- `accessToken` — JWT access token
- `initialSnapshot` — Initial caller-scoped snapshot (from SSR fetch)

### Returns

An `ActorKitClient<TMachine>` with the following methods:

### `client.connect()`

Establishes a WebSocket connection to the actor server.

### `client.disconnect()`

Closes the WebSocket connection.

### `client.send(event)`

Sends a client event to the actor. The event must match your `ClientEventFrom<TMachine>` type.

```typescript
client.send({ type: "ADD_TODO", text: "Buy milk" });
```

### `client.getState()`

Returns the current caller-scoped snapshot (`CallerSnapshotFrom<TMachine>`).

### `client.subscribe(listener)`

Registers a listener that's called on every state change. Returns an unsubscribe function.

```typescript
const unsubscribe = client.subscribe((snapshot) => {
  console.log("New state:", snapshot);
});
```

### `client.waitFor(predicate, timeoutMs?)`

Returns a Promise that resolves when the predicate returns `true` for the current state. Optional timeout in milliseconds.

```typescript
await client.waitFor((state) => state.value === "ready");

await client.waitFor(
  (state) => state.public.todos.length > 0,
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

Select derived state from the current snapshot:

```typescript
const count = client.select((s) => s.public.todos.length);
```

### `client.onStateChange(listener)`

Register a callback for state changes. Similar to `subscribe` but receives the full snapshot:

```typescript
client.onStateChange((snapshot) => {
  console.log("State:", snapshot.value);
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
import type { TodoMachine } from "./todo.machine";

const client = createActorKitClient<TodoMachine>({
  host: "your-worker.workers.dev",
  actorType: "todo",
  actorId: "todo-123",
  checksum: "initial-checksum",
  accessToken: "your-access-token",
  initialSnapshot: {
    public: { ownerId: "user-1", todos: [], lastSync: null },
    private: { accessCount: 0 },
    value: "ready",
  },
});

await client.connect();
client.send({ type: "ADD_TODO", text: "Buy milk" });
```

> In most cases, you'll use `@actor-kit/react` instead of the browser client directly. The React provider handles connection lifecycle automatically.
