import { AnyStateMachine, createActor, InputFrom } from "xstate";
import {
  ActorKitClient,
  AnyActorKitStateMachine,
  CallerSnapshotFrom,
  ClientEventFrom,
} from "./types";

export type ActorKitMachineClientProps<TMachine extends AnyActorKitStateMachine> = {
  machine: TMachine;
  input: InputFrom<TMachine>;
  /** The caller ID to scope private data. Defaults to the input caller ID. */
  callerId?: string;
};

/**
 * Creates a mock Actor Kit client that runs the real XState machine.
 *
 * Unlike `createActorKitMockClient` which stores state as a plain object,
 * this client runs the actual XState machine — guards are evaluated,
 * actions execute, and transitions follow the machine definition.
 *
 * Events are augmented with `caller`, `storage`, and `env` fields to match
 * the production event shape from `createMachineServer`. Private data is
 * scoped to the caller ID (matching production behavior).
 *
 * Use this in Storybook stories or tests that need to verify machine logic,
 * not just UI state.
 */
export function createActorKitMachineClient<TMachine extends AnyActorKitStateMachine>(
  props: ActorKitMachineClientProps<TMachine>
): ActorKitClient<TMachine> {
  const input = props.input as Record<string, unknown>;
  const caller = input.caller as { id: string; type: string } | undefined;
  const callerId = props.callerId ?? caller?.id ?? "unknown";

  const actor = createActor(props.machine as AnyStateMachine, {
    input: props.input,
  });

  const listeners = new Set<(state: CallerSnapshotFrom<TMachine>) => void>();

  const getCallerSnapshot = (): CallerSnapshotFrom<TMachine> => {
    const snapshot = actor.getSnapshot();
    const ctx = snapshot.context as {
      public: Record<string, unknown>;
      private: Record<string, Record<string, unknown>>;
    };
    return {
      public: ctx.public,
      // Scope private data to this caller, matching production behavior
      private: ctx.private?.[callerId] ?? {},
      value: snapshot.value,
    } as CallerSnapshotFrom<TMachine>;
  };

  actor.subscribe(() => {
    const snapshot = getCallerSnapshot();
    listeners.forEach((listener) => listener(snapshot));
  });

  actor.start();

  return {
    send: (event: ClientEventFrom<TMachine>) => {
      // Augment with caller, storage, and env to match production event shape.
      // If the event already has a caller (e.g., from test code), use it.
      // Storage and env are stubs — guards/actions that access them will get
      // empty objects rather than crashing on undefined.
      const eventObj = event as Record<string, unknown>;
      const augmented = {
        ...event,
        caller: eventObj.caller ?? caller ?? { id: callerId, type: "client" },
        storage: eventObj.storage ?? {},
        env: eventObj.env ?? {},
      };
      actor.send(augmented as Parameters<typeof actor.send>[0]);
    },
    getState: getCallerSnapshot,
    subscribe: (listener: (state: CallerSnapshotFrom<TMachine>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: async () => {},
    disconnect: () => {},
    waitFor: async (
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
            unsubscribe();
            reject(new Error(`Timeout waiting for condition after ${timeoutMs}ms`));
          }, timeoutMs);
        }

        const unsubscribe = (() => {
          const unsub = (state: CallerSnapshotFrom<TMachine>) => {
            if (predicateFn(state)) {
              if (timeoutId) clearTimeout(timeoutId);
              listeners.delete(unsub);
              resolve();
            }
          };
          listeners.add(unsub);
          return () => listeners.delete(unsub);
        })();
      });
    },
  };
}
