/**
 * XState adapter for actor-kit.
 *
 * Wraps an XState machine in the ActorLogic interface so it can be used
 * with createDurableActor. Handles event augmentation (caller/env),
 * snapshot serialization, and migration via xstate-migrate.
 */
import {
  type AnyStateMachine,
  type AnyEventObject,
  type SnapshotFrom,
  type InputFrom,
  createActor,
} from "xstate";
import { xstateMigrate } from "xstate-migrate";
import type { ActorLogic, Caller, BaseEnv } from "@actor-kit/core";

type FromXStateMachineOptions<
  TMachine extends AnyStateMachine,
  TView,
> = {
  /** Map the machine's snapshot to a caller-scoped view. */
  getView: (snapshot: SnapshotFrom<TMachine>, caller: Caller) => TView;
};

/**
 * Creates an ActorLogic from an XState machine definition.
 *
 * The machine's events are augmented with `caller` and `env` before
 * being sent — this matches the existing actor-kit convention where
 * machine event types include `BaseActorKitEvent`.
 *
 * @example
 * ```ts
 * const logic = fromXStateMachine(todoMachine, {
 *   getView: (snapshot, caller) => ({
 *     todos: snapshot.context.todos,
 *     isOwner: snapshot.context.ownerId === caller.id,
 *   }),
 * });
 * ```
 */
export function fromXStateMachine<
  TMachine extends AnyStateMachine,
  TView,
  TEnv extends BaseEnv = BaseEnv,
>(
  machine: TMachine,
  options: FromXStateMachineOptions<TMachine, TView>
): ActorLogic<
  SnapshotFrom<TMachine>,
  AnyEventObject,
  TView,
  TEnv,
  Record<string, unknown>
> {
  return {
    create(input: Record<string, unknown>): SnapshotFrom<TMachine> {
      const actor = createActor(machine, {
        input: input as InputFrom<TMachine>,
      });
      actor.start();
      const snapshot = actor.getSnapshot();
      actor.stop();
      return snapshot;
    },

    transition(
      state: SnapshotFrom<TMachine>,
      event: AnyEventObject & { caller: Caller; env: TEnv }
    ): SnapshotFrom<TMachine> {
      // Restore actor from snapshot, send event, get next snapshot
      // XState's generic constraints are very strict — these casts are safe
      // because the snapshot and event shapes match the machine's types.
      const actor = createActor(machine, {
        snapshot: state,
      } as unknown as Parameters<typeof createActor<TMachine>>[1]);
      actor.start();
      actor.send(event as unknown as Parameters<typeof actor.send>[0]);
      const nextSnapshot = actor.getSnapshot();
      actor.stop();
      return nextSnapshot;
    },

    getView(state: SnapshotFrom<TMachine>, caller: Caller): TView {
      return options.getView(state, caller);
    },

    serialize(state: SnapshotFrom<TMachine>): unknown {
      return state;
    },

    restore(serialized: unknown): SnapshotFrom<TMachine> {
      return serialized as SnapshotFrom<TMachine>;
    },

    migrate(
      serialized: unknown,
      _version?: number
    ): SnapshotFrom<TMachine> {
      const persistedSnapshot = serialized as SnapshotFrom<TMachine>;
      // Use xstate-migrate for automatic migration
      const migrations = xstateMigrate.generateMigrations(
        machine,
        persistedSnapshot,
        {} as InputFrom<TMachine>
      );
      return xstateMigrate.applyMigrations(
        persistedSnapshot,
        migrations
      ) as SnapshotFrom<TMachine>;
    },

    onConnect(state: SnapshotFrom<TMachine>, _caller: Caller): SnapshotFrom<TMachine> {
      // XState machines can handle CONNECT as a regular event if they want
      return state;
    },

    onDisconnect(state: SnapshotFrom<TMachine>, _caller: Caller): SnapshotFrom<TMachine> {
      return state;
    },

    onResume(state: SnapshotFrom<TMachine>): SnapshotFrom<TMachine> {
      return state;
    },
  };
}
