import type { Meta, StoryObj } from "@storybook/react";
import { expect, within, userEvent } from "@storybook/test";
import React from "react";
import { createActorKitMockClient } from "@actor-kit/test";
import { withActorKit } from "@actor-kit/storybook";
import { Counter } from "../src/Counter";
import { CounterContext } from "../src/counter.context";
import type { CounterMachine, CounterSnapshot } from "../src/counter.machine";

const defaultSnapshot: CounterSnapshot = {
  public: { count: 0 },
  private: {},
  value: "active",
};

const meta: Meta<typeof Counter> = {
  title: "Counter",
  component: Counter,
};

export default meta;
type Story = StoryObj<typeof Counter>;

/**
 * Static story: uses withActorKit decorator + parameters.
 * Verifies that the component renders the initial state correctly.
 */
export const Default: Story = {
  decorators: [
    withActorKit<CounterMachine>({
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
    withActorKit<CounterMachine>({
      actorType: "counter",
      context: CounterContext,
    }),
  ],
  parameters: {
    actorKit: {
      counter: {
        "counter-1": {
          ...defaultSnapshot,
          public: { count: 42 },
        },
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
 * Verifies that clicking buttons sends the correct events
 * and that produce() updates render correctly.
 */
export const Interactive: Story = {
  render: () => <Counter />,
  play: async ({ canvasElement, mount }) => {
    const client = createActorKitMockClient<CounterMachine>({
      initialSnapshot: defaultSnapshot,
      onSend: (event) => {
        // Simulate machine behavior in response to events
        if (event.type === "INCREMENT") {
          client.produce((draft) => {
            (draft.public as { count: number }).count += 1;
          });
        } else if (event.type === "DECREMENT") {
          client.produce((draft) => {
            (draft.public as { count: number }).count -= 1;
          });
        } else if (event.type === "RESET") {
          client.produce((draft) => {
            (draft.public as { count: number }).count = 0;
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

    // Initial state
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 0");

    // Click increment
    await userEvent.click(canvas.getByText("+"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 1");

    // Click increment again
    await userEvent.click(canvas.getByText("+"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 2");

    // Click decrement
    await userEvent.click(canvas.getByText("-"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 1");

    // Click reset
    await userEvent.click(canvas.getByText("Reset"));
    await expect(canvas.getByTestId("count")).toHaveTextContent("Count: 0");
  },
};
