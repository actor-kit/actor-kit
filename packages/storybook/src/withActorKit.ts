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

import { type ReactNode, createElement } from "react";
import type { ActorClient } from "@actor-kit/client";
import { createMockClient } from "./mock-client";

interface WithActorKitOptions<TView, TMessage extends { type: string }> {
  /** The actorContext() result — provides Provider */
  context: {
    Provider: (props: {
      client: ActorClient<TView, TMessage>;
      children?: ReactNode;
    }) => ReactNode;
  };
  /** Initial view data for the mock client */
  view: TView;
  /** Optional role (default: "user") */
  role?: string;
  /** Optional send handler for interactive stories */
  onSend?: (message: { type: string; [key: string]: unknown }) => TView | void;
}

/**
 * Storybook decorator that wraps stories in an actor-kit context provider
 * with a mock client.
 */
export function withActorKit<
  TView,
  TMessage extends { type: string } = { type: string; [key: string]: unknown },
>(options: WithActorKitOptions<TView, TMessage>) {
  const { context, view, role, onSend } = options;

  // Return a Storybook decorator function
  // Storybook's decorator types vary by version — we use ReactNode for
  // createElement compatibility without depending on @storybook/react internals
  return (Story: () => ReactNode): ReactNode => {
    const client = createMockClient<TView, TMessage>({
      initialView: view,
      role,
      onSend,
    });

    return createElement(
      context.Provider,
      { client },
      createElement(Story),
    );
  };
}
