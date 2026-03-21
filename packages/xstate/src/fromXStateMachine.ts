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
  type EventFromLogic,
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
 * Uses AnyStateMachine internally to avoid XState's strict generic
 * constraints. The machine's events must include caller/env fields
 * (the standard actor-kit event augmentation pattern).
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
  // Use the machine typed as AnyStateMachine to avoid generic constraint issues.
  // XState's createActor(AnyStateMachine) accepts any snapshot/event without
  // strict generic matching — this is the intended escape hatch.
  const anyMachine: AnyStateMachine = machine;

  return {
    create(input: Record<string, unknown>): SnapshotFrom<TMachine> {
      const actor = createActor(anyMachine, { input });
      actor.start();
      const snapshot = actor.getSnapshot() as SnapshotFrom<TMachine>;
      actor.stop();
      return snapshot;
    },

    transition(
      state: SnapshotFrom<TMachine>,
      event: AnyEventObject & { caller: Caller; env: TEnv }
    ): SnapshotFrom<TMachine> {
      const actor = createActor(anyMachine, { snapshot: state });
      actor.start();
      actor.send(event);
      const nextSnapshot = actor.getSnapshot() as SnapshotFrom<TMachine>;
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
      // Persistence boundary — serialized data is untyped by nature.
      // The snapshot shape is validated by XState when used with createActor.
      return serialized as SnapshotFrom<TMachine>;
    },

    migrate(
      serialized: unknown,
      _version?: number
    ): SnapshotFrom<TMachine> {
      // xstate-migrate handles snapshot schema evolution automatically
      const persistedSnapshot = serialized as SnapshotFrom<TMachine>;
      const migrations = xstateMigrate.generateMigrations(
        machine,
        persistedSnapshot,
        {} as InputFrom<TMachine>
      );
      const migrated = xstateMigrate.applyMigrations(persistedSnapshot, migrations);
      return migrated as SnapshotFrom<TMachine>;
    },

    onConnect(state: SnapshotFrom<TMachine>): SnapshotFrom<TMachine> {
      return state;
    },

    onDisconnect(state: SnapshotFrom<TMachine>): SnapshotFrom<TMachine> {
      return state;
    },

    onResume(state: SnapshotFrom<TMachine>): SnapshotFrom<TMachine> {
      return state;
    },
  };
}
