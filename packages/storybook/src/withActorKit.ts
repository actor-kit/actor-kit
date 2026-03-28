/**
 * withActorKit — Storybook decorator that wraps stories in actor-kit providers.
 *
 * Creates a mock client from the story's parameters and wraps the story
 * in the appropriate context provider.
 *
 * @example
 * ```tsx
 * import { withActorKit } from "@actor-kit/storybook";
 *
 * export const Default: Story = {
 *   decorators: [
 *     withActorKit({
 *       context: CounterCtx,
 *       view: { count: 0, lastUpdatedBy: "" },
 *     }),
 *   ],
 * };
 * ```
 */

import type { ActorClient } from "@actor-kit/client";
import { createMockClient } from "./mock-client";

interface WithActorKitOptions<TView, TEvent extends { type: string }> {
  /** The actorContext() result — provides Provider */
  context: {
    Provider: (props: {
      client: ActorClient<TView, TEvent>;
      children: unknown;
    }) => unknown;
  };
  /** Initial view data for the mock client */
  view: TView;
  /** Optional role (default: "user") */
  role?: string;
  /** Optional send handler for interactive stories */
  onSend?: (event: { type: string; [key: string]: unknown }) => TView | void;
}

/**
 * Storybook decorator that wraps stories in an actor-kit context provider
 * with a mock client.
 */
export function withActorKit<
  TView,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
>(options: WithActorKitOptions<TView, TEvent>) {
  const { context, view, role, onSend } = options;

  // Return a Storybook decorator function
  // Using `any` here is unavoidable — Storybook's decorator types vary by version
  // and we can't depend on a specific @storybook/react version's internal types
  return (Story: () => unknown): unknown => {
    const client = createMockClient<TView, TEvent>({
      initialView: view,
      role,
      onSend,
    });

    // Use createElement to avoid JSX dependency
    const React = require("react");
    return React.createElement(
      context.Provider,
      { client },
      React.createElement(Story),
    );
  };
}
