---
title: "@actor-kit/storybook"
description: Storybook decorator and mock client for visual testing.
---

The storybook package (`@actor-kit/storybook`) provides a decorator and mock client for testing actor-powered components in Storybook without a WebSocket connection.

## `withActorKit(options)`

Storybook decorator that wraps stories in an actor-kit context provider with a mock client.

```tsx
import { withActorKit } from "@actor-kit/storybook";
import { CounterCtx } from "./counter.context";

export const Default: Story = {
  decorators: [
    withActorKit({
      context: CounterCtx,
      view: { count: 42, lastUpdatedBy: "alice" },
    }),
  ],
};
```

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `context` | `{ Provider }` | Yes | The `actorContext()` result — provides the Provider |
| `view` | `TView` | Yes | Initial view data for the mock client |
| `role` | `string` | No | Caller role (default: `"user"`) |
| `onSend` | `(message: TMessage) => TView \| void` | No | Handler for `send()` — return a new view to update state |

### Interactive stories with `onSend`

Use `onSend` to make stories interactive — the handler receives messages and can return an updated view:

```tsx
export const Interactive: Story = {
  decorators: [
    withActorKit({
      context: CounterCtx,
      view: { count: 0, lastUpdatedBy: "" },
      onSend: (message) => {
        if (message.type === "INCREMENT") {
          return { count: 1, lastUpdatedBy: "storybook" };
        }
      },
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("+"));
    await expect(canvas.getByText("1")).toBeInTheDocument();
  },
};
```

### Role-based stories

Test different role views by passing `role`:

```tsx
export const OwnerView: Story = {
  decorators: [
    withActorKit({
      context: TodoCtx,
      view: { todos: [{ id: "1", text: "Buy milk", done: false }], memberCount: 3 },
      role: "owner",
    }),
  ],
};

export const ViewerView: Story = {
  decorators: [
    withActorKit({
      context: TodoCtx,
      view: { todoCount: 5, doneCount: 2 },
      role: "viewer",
    }),
  ],
};
```

## `createMockClient(options)`

Creates a mock `ActorClient` without a WebSocket connection. Used internally by `withActorKit`, but also useful for custom test setups.

```typescript
import { createMockClient } from "@actor-kit/storybook";

const client = createMockClient({
  initialView: { count: 0, lastUpdatedBy: "" },
  role: "user",
  connectionState: "connected",
});

// client.view → { count: 0, lastUpdatedBy: "" }
// client.role → "user"
// client.connectionState → "connected"
```

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `initialView` | `TView` | Yes | Initial view data |
| `role` | `string` | No | Caller role (default: `"user"`) |
| `connectionState` | `ConnectionState` | No | Initial state (default: `"connected"`) |
| `onSend` | `(message: TMessage) => TView \| void` | No | Handler for `send()` — return a new view to update |

When `onSend` returns a new view, all `subscribe()` listeners are notified with the updated view. When it returns `void`, the view stays unchanged.
