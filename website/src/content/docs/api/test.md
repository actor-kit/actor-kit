---
title: "@actor-kit/test"
description: Mock client for testing Actor Kit components without a live server.
---

The test package provides a mock implementation of `ActorKitClient` for unit and integration testing.

## `createActorKitMockClient<TView, TEvent>(props)`

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `initialSnapshot` | `TView` | Starting view state |
| `onSend?` | `(event: TEvent) => void` | Callback when events are sent |

### Returns

A mock client implementing `ActorKitClient<TView, TEvent>` with all standard methods plus testing utilities:

| Method | Description |
|--------|-------------|
| `send(event)` | Send a client event (triggers `onSend` callback) |
| `getState()` | Returns current view snapshot |
| `subscribe(listener)` | Register a state change listener |
| `produce(recipe)` | Immer-based direct state mutation |
| `waitFor(predicate, timeoutMs?)` | Wait for a state condition (default 5s timeout) |
| `trigger` | Typed proxy for `send` — e.g., `trigger.ADD_TODO({ text: "..." })` |
| `select(selector)` | Select derived state |

### Basic usage

```typescript
import { createActorKitMockClient } from "@actor-kit/test";

type TodoView = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  isOwner: boolean;
  lastSync: number | null;
};

type TodoClientEvent =
  | { type: "ADD_TODO"; text: string }
  | { type: "TOGGLE_TODO"; id: string };

const mockClient = createActorKitMockClient<TodoView, TodoClientEvent>({
  initialSnapshot: {
    ownerId: "user-1",
    todos: [],
    isOwner: true,
    lastSync: null,
  },
});

// Directly manipulate state
mockClient.produce((draft) => {
  draft.todos.push({ id: "1", text: "Test", completed: false });
});

expect(mockClient.getState().todos).toHaveLength(1);
```

### Spy on events

```typescript
const sendSpy = vi.fn();
const mockClient = createActorKitMockClient<TodoView, TodoClientEvent>({
  initialSnapshot: { /* ... */ },
  onSend: sendSpy,
});

mockClient.send({ type: "ADD_TODO", text: "Test" });
expect(sendSpy).toHaveBeenCalledWith({ type: "ADD_TODO", text: "Test" });
```

### Simulate server responses

```typescript
const mockClient = createActorKitMockClient<TodoView, TodoClientEvent>({
  initialSnapshot: { /* ... */ },
  onSend: (event) => {
    if (event.type === "ADD_TODO") {
      mockClient.produce((draft) => {
        draft.todos.push({
          id: crypto.randomUUID(),
          text: event.text,
          completed: false,
        });
      });
    }
  },
});
```

### Wait for state conditions

```typescript
// Wait for todos to be loaded
await mockClient.waitFor((v) => v.todos.length > 0);

// With custom timeout
await mockClient.waitFor(
  (v) => v.todos.length > 0,
  10000 // 10 seconds
);
```

### Typed event dispatch with trigger

```typescript
// Instead of: mockClient.send({ type: "ADD_TODO", text: "Test" })
mockClient.trigger.ADD_TODO({ text: "Test" });
mockClient.trigger.TOGGLE_TODO({ id: "1" });
```

### With React testing

```tsx
import { render } from "@testing-library/react";
import { TodoActorKitContext } from "./todo.context";

render(
  <TodoActorKitContext.ProviderFromClient client={mockClient}>
    <YourComponent />
  </TodoActorKitContext.ProviderFromClient>
);
```
