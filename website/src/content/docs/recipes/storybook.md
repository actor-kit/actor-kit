---
title: Storybook Testing
description: Visual component testing with Storybook play functions and actor-kit mock clients.
---

`@actor-kit/storybook` provides a Storybook decorator and mock client for rendering components that depend on actor-kit state — without a real WebSocket connection.

## Install

```bash
pnpm add -D @actor-kit/storybook
```

## Static stories with `withActorKit`

The `withActorKit` decorator creates a mock client with initial view data and wraps your story in the context provider:

```typescript
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "@storybook/test";
import { withActorKit } from "@actor-kit/storybook";
import { Counter } from "./Counter";
import { CounterCtx } from "./counter.context";

const meta: Meta<typeof Counter> = {
  title: "Counter",
  component: Counter,
};
export default meta;
type Story = StoryObj<typeof Counter>;

export const Default: Story = {
  decorators: [
    withActorKit({
      context: CounterCtx,
      view: { count: 0, lastUpdatedBy: "" },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("0")).toBeVisible();
  },
};

export const WithCount: Story = {
  decorators: [
    withActorKit({
      context: CounterCtx,
      view: { count: 42, lastUpdatedBy: "alice" },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("42")).toBeVisible();
  },
};
```

## Interactive stories with `onSend`

Use `onSend` to handle button clicks and update the view in play functions:

```typescript
export const Interactive: Story = {
  decorators: [
    withActorKit({
      context: CounterCtx,
      view: { count: 0, lastUpdatedBy: "" },
      onSend: (message) => {
        if (message.type === "INCREMENT") {
          // Return a new view — the mock client updates and re-renders
          return { count: 1, lastUpdatedBy: "test" };
        }
      },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("0")).toBeVisible();

    // Click increment
    await canvas.getByRole("button", { name: "+" }).click();

    // View should update
    await expect(canvas.getByText("1")).toBeVisible();
  },
};
```

## Role-specific rendering

Test how your UI adapts to different roles:

```typescript
export const OwnerView: Story = {
  decorators: [
    withActorKit({
      context: TodoCtx,
      view: { todos: [{ id: "1", text: "Test", done: false }], memberCount: 2 },
      role: "owner",
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Owner should see delete button
    await expect(canvas.getByRole("button", { name: "Delete" })).toBeVisible();
  },
};

export const ViewerView: Story = {
  decorators: [
    withActorKit({
      context: TodoCtx,
      view: { todoCount: 3, doneCount: 1 },
      role: "viewer",
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Viewer should see counts, not individual todos
    await expect(canvas.getByText("3 todos")).toBeVisible();
  },
};
```

## Mock client directly

For more control, create a mock client directly:

```typescript
import { createMockClient } from "@actor-kit/storybook";

const client = createMockClient<CounterView, CounterMessage>({
  initialView: { count: 0, lastUpdatedBy: "" },
  role: "user",
  onSend: (message) => {
    if (message.type === "INCREMENT") {
      return { count: (client.view?.count ?? 0) + 1, lastUpdatedBy: "test" };
    }
  },
});

// Use in a custom provider setup
<CounterCtx.Provider client={client}>
  <Counter />
</CounterCtx.Provider>
```

## API

### `withActorKit(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `context` | `actorContext()` result | Yes | The context that provides `useView()`, `useSend()`, etc. |
| `view` | `TView` | Yes | Initial view data |
| `role` | `string` | No | Role for `useRole()` (default: "user") |
| `onSend` | `(message) => TView \| void` | No | Handle `send()` calls. Return a new view to update, or void to ignore. |

### `createMockClient(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `initialView` | `TView` | Yes | Initial view data |
| `role` | `string` | No | Role (default: "user") |
| `connectionState` | `ConnectionState` | No | Initial state (default: "connected") |
| `onSend` | `(message) => TView \| void` | No | Handle sends interactively |
