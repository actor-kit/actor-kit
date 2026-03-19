import {
  type AnyStateMachine,
  type InputFrom,
  createActor,
} from "xstate";
import { createSelector } from "./selector";
import type {
  ActorKitClient,
  ActorKitSelector,
  AnyActorKitStateMachine,
  Caller,
  CallerSnapshotFrom,
  ClientEventFrom,
} from "./types";

export type ActorKitMachineClientOptions<
  TMachine extends AnyActorKitStateMachine,
> = {
  /** The XState machine definition. */
  machine: TMachine;
  /** The caller identity for event augmentation. */
  caller: Caller;
  /** Optional input props (merged with default mock input). */
  input?: Record<string, unknown>;
};

/**
 * Mock storage for the machine client — all operations are no-ops.
 */
const mockStorage = new Proxy(
  {},
  { get: () => () => Promise.resolve() }
) as DurableObjectStorage;

/**
 * Mock env for the machine client.
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

/**
 * Creates a mock client backed by a real running XState actor.
 *
 * Unlike `createActorKitMockClient` (snapshot-only), this client starts the
 * machine so guards, actions, and invoked actors actually execute. Useful for
 * Storybook stories and integration tests that need real machine behavior.
 */
export function createActorKitMachineClient<
  TMachine extends AnyActorKitStateMachine,
>(
  options: ActorKitMachineClientOptions<TMachine>
): ActorKitClient<TMachine> {
  const { machine, caller, input: inputProps } = options;

  const machineInput = {
    id: "mock-actor",
    caller,
    storage: mockStorage,
    env: mockEnv,
    ...(inputProps ?? {}),
  } as InputFrom<TMachine>;

  const actor = createActor(machine as AnyStateMachine, {
    input: machineInput as InputFrom<AnyStateMachine>,
  });
  actor.start();

  const listeners = new Set<
    (state: CallerSnapshotFrom<TMachine>) => void
  >();

  // Subscribe to XState actor, forward to listeners
  actor.subscribe(() => {
    const callerSnapshot = getCallerSnapshot();
    listeners.forEach((l) => l(callerSnapshot));
  });

  function getCallerSnapshot(): CallerSnapshotFrom<TMachine> {
    const fullSnapshot = actor.getSnapshot() as unknown as {
      value: unknown;
      context: {
        public: unknown;
        private: Record<string, unknown>;
      };
    };
    return {
      public: fullSnapshot.context.public,
      private:
        fullSnapshot.context.private[caller.id] ??
        ({} as CallerSnapshotFrom<TMachine>["private"]),
      value: fullSnapshot.value,
    } as CallerSnapshotFrom<TMachine>;
  }

  const send = (event: ClientEventFrom<TMachine>) => {
    // Augment event with caller, storage, env — same as createMachineServer
    actor.send({
      ...event,
      caller,
      storage: mockStorage,
      env: mockEnv,
    } as unknown as Parameters<typeof actor.send>[0]);
  };

  const getState = () => getCallerSnapshot();

  const subscribe = (
    listener: (state: CallerSnapshotFrom<TMachine>) => void
  ) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const connect = async () => {
    // No-op for machine client
  };

  const disconnect = () => {
    // No-op for machine client
  };

  const waitFor = async (
    predicateFn: (state: CallerSnapshotFrom<TMachine>) => boolean,
    timeoutMs: number = 5000
  ): Promise<void> => {
    if (predicateFn(getCallerSnapshot())) {
      return;
    }
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          unsub();
          reject(
            new Error(`Timeout waiting for condition after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }
      const unsub = subscribe((state) => {
        if (predicateFn(state)) {
          if (timeoutId) clearTimeout(timeoutId);
          unsub();
          resolve();
        }
      });
    });
  };

  const select = <TSelected>(
    selectorFn: (state: CallerSnapshotFrom<TMachine>) => TSelected,
    equalityFn?: (a: TSelected, b: TSelected) => boolean
  ): ActorKitSelector<TSelected> =>
    createSelector(getState, subscribe, selectorFn, equalityFn);

  const trigger = new Proxy({} as ActorKitClient<TMachine>["trigger"], {
    get(_target, eventType: string) {
      return (payload?: Record<string, unknown>) => {
        send({ type: eventType, ...payload } as ClientEventFrom<TMachine>);
      };
    },
  });

  return {
    connect,
    disconnect,
    send,
    getState,
    subscribe,
    waitFor,
    select,
    trigger,
  };
}
