import type { AnyActorKitStateMachine, CallerSnapshotFrom } from "./types";

export { withActorKit } from "./withActorKit";

/**
 * Configuration interface for actor-kit state machines in stories.
 * Allows configuring multiple actors with different initial states.
 *
 * @template TMachine - Type of the actor-kit state machine
 *
 * @example
 * ```tsx
 * parameters: {
 *   actorKit: {
 *     session: {
 *       "session-123": {
 *         public: { userId: "123" },
 *         private: {},
 *         value: "ready"
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface ActorKitParameters<TMachine extends AnyActorKitStateMachine> {
  actorKit: {
    [K: string]: {
      [actorId: string]: CallerSnapshotFrom<TMachine>;
    };
  };
}

/**
 * Helper type for stories that use actor-kit state machines.
 * Combines the story type with actor-kit parameters.
 *
 * @template TMachine - Type of the actor-kit state machine
 */
export type StoryWithActorKit<TMachine extends AnyActorKitStateMachine> = {
  parameters: ActorKitParameters<TMachine>;
};
