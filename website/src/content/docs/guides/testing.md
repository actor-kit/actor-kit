---
title: Testing
description: Test your Actor Kit components without a live server using mock clients.
---

Actor Kit provides `@actor-kit/test` for testing components that depend on actor state, without needing a running Cloudflare Worker.

## Install

```bash
pnpm add -D @actor-kit/test
```

## createActorKitMockClient

The mock client implements the full `ActorKitClient` interface plus an `produce` method for directly manipulating state with Immer:

```typescript
import { createActorKitMockClient } from "@actor-kit/test";
import type { TodoMachine } from "./todo.machine";

const mockClient = createActorKitMockClient<TodoMachine>({
  initialSnapshot: {
    public: {
      ownerId: "user-1",
      todos: [],
      lastSync: null,
    },
    private: { accessCount: 0 },
    value: "ready",
  },
});
```

## Manipulating state

Use `produce` to update the snapshot with Immer:

```typescript
mockClient.produce((draft) => {
  draft.public.todos.push({
    id: "1",
    text: "Test todo",
    completed: false,
  });
  draft.value = "ready";
});

expect(mockClient.getState().public.todos).toHaveLength(1);
```

## Spying on events

Pass an `onSend` callback to track what events your components send:

```typescript
const sendSpy = vi.fn();
const mockClient = createActorKitMockClient<TodoMachine>({
  initialSnapshot: { /* ... */ },
  onSend: sendSpy,
});

mockClient.send({ type: "ADD_TODO", text: "Test" });

expect(sendSpy).toHaveBeenCalledWith({
  type: "ADD_TODO",
  text: "Test",
});
```

## Testing React components

Wrap your component with the context provider and pass the mock client:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodoActorKitContext } from "./todo.context";
import { TodoList } from "./components/TodoList";

describe("TodoList", () => {
  it("renders todos and handles add", async () => {
    const sendSpy = vi.fn();
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { ownerId: "user-1", todos: [], lastSync: null },
        private: { accessCount: 0 },
        value: "ready",
      },
      onSend: sendSpy,
    });

    render(
      <TodoActorKitContext.ProviderFromClient client={mockClient}>
        <TodoList userId="user-1" />
      </TodoActorKitContext.ProviderFromClient>
    );

    const input = screen.getByPlaceholderText("Add a new todo");
    await userEvent.type(input, "Buy milk");
    await userEvent.click(screen.getByText("Add"));

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ADD_TODO", text: "Buy milk" })
    );
  });
});
```

## Simulating state changes in tests

Combine `onSend` with `produce` to simulate how the server would respond:

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

This pattern lets you test the full cycle: user interaction → event sent → state updated → UI re-renders.
