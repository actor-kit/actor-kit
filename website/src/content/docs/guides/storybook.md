---
title: Storybook
description: Use Actor Kit with Storybook for visual component development and play function testing.
---

`@actor-kit/storybook` provides a decorator for rendering components that depend on Actor Kit state. `@actor-kit/test` provides a mock client for interactive stories.

> **Source code**: [examples/storybook-tests](https://github.com/actor-kit/actor-kit/tree/main/examples/storybook-tests)

## Install

```bash
pnpm add -D @actor-kit/storybook @actor-kit/test
```

## Static stories with `withActorKit`

Use the decorator to provide initial state via `parameters`:

```typescript
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "@storybook/test";
import { withActorKit } from "@actor-kit/storybook";
import { Counter } from "../src/Counter";
import { CounterContext } from "../src/counter.context";

// Define your view and event types
type CounterView = { count: number };
type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

const meta: Meta<typeof Counter> = {
  title: "Counter",
  component: Counter,
};
export default meta;
type Story = StoryObj<typeof Counter>;

export const Default: Story = {
  decorators: [
    withActorKit<CounterView, CounterEvent>({
      actorType: "counter",
      context: CounterContext,
    }),
  ],
  parameters: {
    actorKit: {
      counter: {
        "counter-1": { count: 0 },  // flat view — no public/private wrapper
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 0");
  },
};

export const WithInitialCount: Story = {
  decorators: [
    withActorKit<CounterView, CounterEvent>({
      actorType: "counter",
      context: CounterContext,
    }),
  ],
  parameters: {
    actorKit: {
      counter: {
        "counter-1": { count: 42 },
      },
    },
  },
};
```

## Interactive stories with mock client

For stories that simulate state changes, use `createActorKitMockClient` directly:

```typescript
import { createActorKitMockClient } from "@actor-kit/test";
import { userEvent } from "@storybook/test";

export const Interactive: Story = {
  render: () => <Counter />,
  play: async ({ canvasElement, mount }) => {
    const client = createActorKitMockClient<CounterView, CounterEvent>({
      initialSnapshot: { count: 0 },
      onSend: (event) => {
        if (event.type === "INCREMENT") {
          client.produce((draft) => { draft.count += 1; });
        } else if (event.type === "DECREMENT") {
          client.produce((draft) => { draft.count -= 1; });
        }
      },
    });

    await mount(
      <CounterContext.ProviderFromClient client={client}>
        <Counter />
      </CounterContext.ProviderFromClient>
    );

    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 0");

    await userEvent.click(canvas.getByText("+"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 1");
  },
};
```

### Key patterns

- **`initialSnapshot`** is your `TView` type — flat, no `public`/`private` wrapper
- **`onSend`** receives events and lets you simulate state changes via `produce()`
- **`produce(draft)`** uses Immer — mutate the draft directly
- **`mount()`** in play functions lets you set up providers before assertions

## Running in CI

Build Storybook, serve it, and run `test-storybook`:

```bash
pnpm build-storybook
npx concurrently -k -s first \
  "npx http-server storybook-static --port 6006 --silent" \
  "npx wait-on tcp:127.0.0.1:6006 && npx test-storybook"
```

See the [CI workflow](https://github.com/actor-kit/actor-kit/blob/main/.github/workflows/ci.yml) for the full setup.
