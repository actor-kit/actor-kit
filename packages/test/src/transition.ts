import {
  type AnyStateMachine,
  type SnapshotFrom,
  createActor,
  type InputFrom,
} from "xstate";
import type {
  AnyActorKitStateMachine,
  CallerSnapshotFrom,
  Caller,
} from "@actor-kit/types";

/**
 * Mock storage that satisfies DurableObjectStorage interface for pure tests.
 * All operations are no-ops — the transition is pure.
 */
const mockStorage = new Proxy(
  {},
  {
    get: () => () => Promise.resolve(),
  }
) as unknown;

/**
 * Mock env that satisfies ActorKitEnv for pure tests.
 */
const mockEnv = new Proxy(
  { ACTOR_KIT_SECRET: "test-secret" },
  {
    get: (target, prop) =>
      prop in target
        ? target[prop as keyof typeof target]
        : undefined,
  }
);

type TransitionOptions<TMachine extends AnyActorKitStateMachine> = {
  /** Starting snapshot. If omitted, the machine starts from its initial state. */
  snapshot?: SnapshotFrom<TMachine>;
  /** The event to apply. */
  event: { type: string; [key: string]: unknown };
  /** The caller sending this event. */
  caller: Caller;
  /** Custom input props (passed to the machine's context factory). */
  input?: Record<string, unknown>;
};

type TransitionResult<TMachine extends AnyActorKitStateMachine> = {
  /** The raw XState snapshot — pass to the next transition() call to chain. */
  snapshot: SnapshotFrom<TMachine>;
  /** The full server context (public + all private). */
  context: SnapshotFrom<TMachine> extends { context: infer C } ? C : unknown;
  /** Caller-scoped snapshot (public + caller's private + state value). */
  callerSnapshot: CallerSnapshotFrom<TMachine>;
};

/**
 * Pure transition function for testing actor-kit state machines.
 *
 * Applies an event to a machine and returns the next state — no DO,
 * no WebSocket, no storage required.
 *
 * ```ts
 * const result = transition(machine, {
 *   event: { type: 'INCREMENT' },
 *   caller: { type: 'client', id: 'user-1' },
 * });
 * expect(result.context.public.count).toBe(1);
 * ```
 */
export function transition<TMachine extends AnyActorKitStateMachine>(
  machine: TMachine,
  options: TransitionOptions<TMachine>
): TransitionResult<TMachine> {
  const { snapshot, event, caller, input: inputProps } = options;

  // Augment event with caller, storage, env — same as createMachineServer.send()
  const augmentedEvent = {
    ...event,
    caller,
    storage: mockStorage,
    env: mockEnv,
  };

  let nextSnapshot: SnapshotFrom<TMachine>;

  if (snapshot) {
    // Apply event to existing snapshot
    const actor = createActor(machine as AnyStateMachine, {
      snapshot: snapshot as SnapshotFrom<AnyStateMachine>,
    });
    actor.start();
    actor.send(augmentedEvent);
    nextSnapshot = actor.getSnapshot() as SnapshotFrom<TMachine>;
    actor.stop();
  } else {
    // Create from initial state with input, apply event
    const machineInput = {
      id: "test-actor",
      caller,
      storage: mockStorage,
      env: mockEnv,
      ...(inputProps ?? {}),
    } as InputFrom<TMachine>;

    const actor = createActor(machine as AnyStateMachine, {
      input: machineInput as InputFrom<AnyStateMachine>,
    });
    actor.start();
    actor.send(augmentedEvent);
    nextSnapshot = actor.getSnapshot() as SnapshotFrom<TMachine>;
    actor.stop();
  }

  const context = (
    nextSnapshot as unknown as { context: unknown }
  ).context as TransitionResult<TMachine>["context"];

  const callerSnapshot = createCallerSnapshot<TMachine>(
    nextSnapshot,
    caller.id
  );

  return { snapshot: nextSnapshot, context, callerSnapshot };
}

function createCallerSnapshot<TMachine extends AnyActorKitStateMachine>(
  fullSnapshot: SnapshotFrom<TMachine>,
  callerId: string
): CallerSnapshotFrom<TMachine> {
  const snap = fullSnapshot as unknown as {
    value: unknown;
    context: {
      public: unknown;
      private: Record<string, unknown>;
    };
  };

  return {
    public: snap.context.public,
    private:
      snap.context.private[callerId] ??
      ({} as CallerSnapshotFrom<TMachine>["private"]),
    value: snap.value,
  } as CallerSnapshotFrom<TMachine>;
}
