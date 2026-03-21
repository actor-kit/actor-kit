---
title: "@actor-kit/storybook"
description: Storybook decorator for Actor Kit components.
---

The storybook package provides a decorator and types for rendering Actor Kit components in Storybook.

## `withActorKit<TMachine>(props)`

Creates a Storybook decorator that provides Actor Kit state from story parameters.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `actorType` | `string` | Actor type identifier |
| `context` | `ActorKitContext` | The context from `createActorKitContext` |

### Example

```typescript
import { withActorKit } from "@actor-kit/storybook";
import { TodoActorKitContext } from "./todo.context";
import type { TodoMachine } from "./todo.machine";

const meta = {
  title: "Components/TodoList",
  component: TodoList,
  decorators: [
    withActorKit<TodoMachine>({
      actorType: "todo",
      context: TodoActorKitContext,
    }),
  ],
};
```

## `StoryWithActorKit<TMachine>`

Adds typed `actorKit` parameters to your story type. This type only covers the `parameters` shape — compose it with Storybook's `StoryObj` for a full story type:

```typescript
import type { Meta, StoryObj } from "@storybook/react";
import type { StoryWithActorKit } from "@actor-kit/storybook";
import type { TodoMachine } from "./todo.machine";

type Story = StoryObj<typeof meta> & StoryWithActorKit<TodoMachine>;

export const Default: Story = {
  parameters: {
    actorKit: {
      todo: {           // actor type
        "todo-1": {     // actor ID
          public: { /* ... */ },
          private: { /* ... */ },
          value: "ready",
        },
      },
    },
  },
};
```

The parameter structure is:

```
actorKit.{actorType}.{actorId} = CallerSnapshotFrom<TMachine>
```

See the [Storybook guide](/guides/storybook/) for full usage patterns.
