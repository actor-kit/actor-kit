---
title: Storybook
description: Use Actor Kit with Storybook for visual component development.
---

`@actor-kit/storybook` provides a decorator for rendering components that depend on Actor Kit state in Storybook stories.

## Install

```bash
pnpm add -D @actor-kit/storybook
```

## Basic setup

Use the `withActorKit` decorator and define initial state via `parameters`:

```typescript
// stories/TodoList.stories.tsx
import type { Meta, StoryObj } from "@storybook/react";
import type { StoryWithActorKit } from "@actor-kit/storybook";
import { withActorKit } from "@actor-kit/storybook";
import { TodoActorKitContext } from "../src/todo.context";
import type { TodoMachine } from "../src/todo.machine";
import { TodoList } from "../src/components/TodoList";

const meta: Meta<typeof TodoList> = {
  title: "Components/TodoList",
  component: TodoList,
  decorators: [
    withActorKit<TodoMachine>({
      actorType: "todo",
      context: TodoActorKitContext,
    }),
  ],
};

export default meta;

type Story = StoryObj<typeof meta> & StoryWithActorKit<TodoMachine>;

export const Empty: Story = {
  args: { userId: "user-1" },
  parameters: {
    actorKit: {
      todo: {
        "todo-1": {
          public: { ownerId: "user-1", todos: [], lastSync: null },
          private: { accessCount: 0 },
          value: "ready",
        },
      },
    },
  },
};

export const WithTodos: Story = {
  args: { userId: "user-1" },
  parameters: {
    actorKit: {
      todo: {
        "todo-1": {
          public: {
            ownerId: "user-1",
            todos: [
              { id: "1", text: "Buy milk", completed: false },
              { id: "2", text: "Walk the dog", completed: true },
            ],
            lastSync: Date.now(),
          },
          private: { accessCount: 5 },
          value: "ready",
        },
      },
    },
  },
};
```

## Interactive stories with mock client

For stories that need to respond to user interactions, use `createActorKitMockClient` directly:

```typescript
import { createActorKitMockClient } from "@actor-kit/test";

export const Interactive: StoryWithActorKit<TodoMachine> = {
  args: { userId: "user-1" },
  render: (args) => {
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { ownerId: "user-1", todos: [], lastSync: null },
        private: { accessCount: 0 },
        value: "ready",
      },
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

    return (
      <TodoActorKitContext.ProviderFromClient client={mockClient}>
        <TodoList {...args} />
      </TodoActorKitContext.ProviderFromClient>
    );
  },
};
```

## Play functions

Use Storybook play functions to test interactions:

```typescript
import { userEvent, within, expect } from "@storybook/test";

export const WithInteraction: StoryWithActorKit<TodoMachine> = {
  // ... render with mock client
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const input = canvas.getByPlaceholderText("Add a new todo");
    await userEvent.type(input, "New todo");
    await userEvent.click(canvas.getByText("Add"));

    await expect(canvas.getByText("New todo")).toBeInTheDocument();
  },
};
```

## Full example

See the complete [Storybook example](https://github.com/actor-kit/actor-kit/tree/main/examples/storybook-tests) in the repo.
