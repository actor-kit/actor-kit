import type { StoryContext, StoryFn } from "@storybook/react";
import React from "react";
import { createActorKitContext } from "./createActorKitContext";
import { createActorKitMockClient } from "./createActorKitMockClient";
import type { AnyActorKitStateMachine } from "./types";
import { ActorKitParameters } from "./storybook";

/**
 * Storybook decorator that sets up actor-kit state machines.
 *
 * There are two main patterns for testing with actor-kit:
 *
 * 1. Static Stories (Use parameters.actorKit + within):
 * - Use this decorator with parameters.actorKit
 * - Use `within(canvasElement)` in play functions
 * - Good for simple stories that don't need state manipulation
 *
 * 2. Interactive Stories (Use mount + direct client):
 * - Don't use this decorator
 * - Create client manually and use mount in play function
 * - Good for stories that need to manipulate state
 *
 * @example
 * ```tsx
 * // Pattern 1: Static Story
 * export const Static: Story = {
 *   parameters: {
 *     actorKit: {
 *       session: {
 *         "session-123": { ... }
 *       }
 *     }
 *   },
 *   play: async ({ canvasElement }) => {
 *     const canvas = within(canvasElement);
 *     // Test UI state...
 *   }
 * };
 *
 * // Pattern 2: Interactive Story
 * export const Interactive: Story = {
 *   play: async ({ canvasElement, mount }) => {
 *     const client = createActorKitMockClient({...});
 *     const canvas = within(canvasElement);
 *
 *     await mount(
 *       <Context.ProviderFromClient client={client}>
 *         <Component />
 *       </Context.ProviderFromClient>
 *     );
 *
 *     // Now you can manipulate client state...
 *     client.produce((draft) => { ... });
 *   }
 * };
 * ```
 */
export const withActorKit = <TMachine extends AnyActorKitStateMachine>({
  actorType,
  context,
}: {
  actorType: string;
  context: ReturnType<typeof createActorKitContext<TMachine>>;
}) => {
  return (Story: StoryFn, storyContext: StoryContext): React.ReactElement => {
    const actorKitParams = storyContext.parameters?.actorKit as
      | ActorKitParameters<TMachine>["actorKit"]
      | undefined;

    // If no params provided, just render the story without any providers
    if (!actorKitParams?.[actorType]) {
      return <Story />;
    }

    // Create nested providers for each actor ID
    const actorSnapshots = actorKitParams[actorType];

    // Recursively nest providers
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
      const client = createActorKitMockClient<TMachine>({
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
