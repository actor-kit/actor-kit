import type { StoryContext, StoryFn } from "@storybook/react";
import React from "react";
import type { ActorKitClient } from "@actor-kit/browser";
import { createActorKitMockClient } from "@actor-kit/test";

export interface ActorKitParameters<TView> {
  actorKit: {
    [K: string]: {
      [actorId: string]: TView;
    };
  };
}

export type StoryWithActorKit<TView> = {
  parameters: ActorKitParameters<TView>;
};

/**
 * Storybook decorator that sets up actor-kit contexts with mock clients.
 *
 * @example
 * ```tsx
 * export const Default: Story = {
 *   decorators: [
 *     withActorKit<CounterView, CounterEvent>({
 *       actorType: "counter",
 *       context: CounterContext,
 *     }),
 *   ],
 *   parameters: {
 *     actorKit: {
 *       counter: { "counter-1": { count: 0 } },
 *     },
 *   },
 * };
 * ```
 */
export const withActorKit = <
  TView,
  TEvent extends { type: string } = { type: string },
>({
  actorType,
  context,
}: {
  actorType: string;
  context: {
    ProviderFromClient: React.FC<{
      children: React.ReactNode;
      client: ActorKitClient<TView, TEvent>;
    }>;
  };
}) => {
  return (Story: StoryFn, storyContext: StoryContext): React.ReactElement => {
    const actorKitParams = storyContext.parameters?.actorKit as
      | ActorKitParameters<TView>["actorKit"]
      | undefined;

    if (!actorKitParams?.[actorType]) {
      return <Story />;
    }

    const actorSnapshots = actorKitParams[actorType];

    const createNestedProviders = (
      actorIds: string[],
      index: number,
      children: React.ReactNode
    ): React.ReactElement => {
      if (index >= actorIds.length) {
        return children as React.ReactElement;
      }

      const actorId = actorIds[index];
      const snapshot = actorSnapshots[actorId];
      const client = createActorKitMockClient<TView, TEvent>({
        initialSnapshot: snapshot,
      });

      return (
        <context.ProviderFromClient client={client}>
          {createNestedProviders(actorIds, index + 1, children)}
        </context.ProviderFromClient>
      );
    };

    return createNestedProviders(Object.keys(actorSnapshots), 0, <Story />);
  };
};
