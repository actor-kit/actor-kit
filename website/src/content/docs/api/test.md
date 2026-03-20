---
title: "@actor-kit/test"
description: Mock client for testing Actor Kit components without a live server.
---

The test package provides a mock implementation of `ActorKitClient` for unit and integration testing.

## `createActorKitMockClient<TMachine>(props)`

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `initialSnapshot` | `CallerSnapshotFrom<TMachine>` | Starting state |
| `onSend?` | `(event) => void` | Callback when events are sent |

### Returns

A mock client implementing `ActorKitClient<TMachine>` plus:

- `produce(recipe)` — Immer-based state mutation

### Basic usage

```typescript
import { createActorKitMockClient } from "@actor-kit/test";
import type { TodoMachine } from "./todo.machine";

const mockClient = createActorKitMockClient<TodoMachine>({
  initialSnapshot: {
    public: { ownerId: "user-1", todos: [], lastSync: null },
    private: { accessCount: 0 },
    value: "ready",
  },
});

// Directly manipulate state
mockClient.produce((draft) => {
  draft.public.todos.push({ id: "1", text: "Test", completed: false });
});

expect(mockClient.getState().public.todos).toHaveLength(1);
```

### Spy on events

```typescript
const sendSpy = vi.fn();
const mockClient = createActorKitMockClient<TodoMachine>({
  initialSnapshot: { /* ... */ },
  onSend: sendSpy,
});

mockClient.send({ type: "ADD_TODO", text: "Test" });
expect(sendSpy).toHaveBeenCalledWith({ type: "ADD_TODO", text: "Test" });
```

### Simulate server responses

```typescript
const mockClient = createActorKitMockClient<TodoMachine>({
  initialSnapshot: { /* ... */ },
  onSend: (event) => {
    if (event.type === "ADD_TODO") {
      mockClient.produce((draft) => {
        draft.public.todos.push({
          id: crypto.randomUUID(),
          text: event.text,
          completed: false,
        });
      });
    }
  },
});
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
