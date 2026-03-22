import type { Meta, StoryObj } from "@storybook/react";
import { expect, within, userEvent } from "@storybook/test";
import React from "react";
import { createActorKitMockClient } from "@actor-kit/test";
import { withActorKit } from "@actor-kit/storybook";
import { Counter } from "../src/Counter";
import { CounterContext } from "../src/counter.context";
import type { CounterView, CounterClientEvent } from "../src/counter.machine";

const defaultSnapshot: CounterView = {
  count: 0,
};

const meta: Meta<typeof Counter> = {
  title: "Counter",
  component: Counter,
};

export default meta;
type Story = StoryObj<typeof Counter>;

/**
 * Static story: uses withActorKit decorator + parameters.
 */
export const Default: Story = {
  decorators: [
    withActorKit<CounterView, CounterClientEvent>({
      actorType: "counter",
      context: CounterContext,
    }),
  ],
  parameters: {
    actorKit: {
      counter: {
        "counter-1": defaultSnapshot,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 0");
    await expect(canvas.getByText("+")).toBeInTheDocument();
    await expect(canvas.getByText("-")).toBeInTheDocument();
    await expect(canvas.getByText("Reset")).toBeInTheDocument();
  },
};

/**
 * Static story with non-zero initial state.
 */
export const WithInitialCount: Story = {
  decorators: [
    withActorKit<CounterView, CounterClientEvent>({
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 42");
  },
};

/**
 * Interactive story: uses createActorKitMockClient directly.
 */
export const Interactive: Story = {
  render: () => <Counter />,
  play: async ({ canvasElement, mount }) => {
    const client = createActorKitMockClient<CounterView, CounterClientEvent>({
      initialSnapshot: defaultSnapshot,
      onSend: (event) => {
        if (event.type === "INCREMENT") {
          client.produce((draft) => {
            draft.count += 1;
          });
        } else if (event.type === "DECREMENT") {
          client.produce((draft) => {
            draft.count -= 1;
          });
        } else if (event.type === "RESET") {
          client.produce((draft) => {
            draft.count = 0;
          });
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

    await userEvent.click(canvas.getByText("+"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 2");

    await userEvent.click(canvas.getByText("-"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 1");

    await userEvent.click(canvas.getByText("Reset"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 0");
  },
};
