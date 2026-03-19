import { Draft, produce } from "immer";
import {
  ActorKitClient,
  AnyActorKitStateMachine,
  CallerSnapshotFrom,
  ClientEventFrom,
} from "./types";

export type ActorKitMockClientProps<TMachine extends AnyActorKitStateMachine> = {
  initialSnapshot: CallerSnapshotFrom<TMachine>;
  onSend?: (event: ClientEventFrom<TMachine>) => void;
};

export type ActorKitMockClient<TMachine extends AnyActorKitStateMachine> = ActorKitClient<TMachine> & {
  produce: (recipe: (draft: Draft<CallerSnapshotFrom<TMachine>>) => void) => void;
};

/**
 * Creates a mock Actor Kit client for testing purposes.
 *
 * @template TMachine - The type of the state machine.
 * @param {ActorKitMockClientProps<TMachine>} props - Configuration options for the mock client.
 * @returns {ActorKitMockClient<TMachine>} An object with methods to interact with the mock actor.
 */
export function createActorKitMockClient<TMachine extends AnyActorKitStateMachine>(
  props: ActorKitMockClientProps<TMachine>
): ActorKitMockClient<TMachine> {
  let currentSnapshot = props.initialSnapshot;
  const listeners: Set<(state: CallerSnapshotFrom<TMachine>) => void> = new Set();

  /**
   * Notifies all registered listeners with the current state.
   */
  const notifyListeners = () => {
    listeners.forEach((listener) => listener(currentSnapshot));
  };

  /**
   * Updates the state using an Immer producer function.
   * @param {(draft: Draft<CallerSnapshotFrom<TMachine>>) => void} recipe - The state update recipe.
   */
  const produceFn = (recipe: (draft: Draft<CallerSnapshotFrom<TMachine>>) => void) => {
    currentSnapshot = produce(currentSnapshot, recipe);
    notifyListeners();
  };

  /**
   * Sends an event to the mock client.
   * @param {ClientEventFrom<TMachine>} event - The event to send.
   */
  const send = (event: ClientEventFrom<TMachine>) => {
    props.onSend?.(event);
    notifyListeners();
  };

  /**
   * Retrieves the current state of the mock actor.
   * @returns {CallerSnapshotFrom<TMachine>} The current state.
   */
  const getState = () => currentSnapshot;

  /**
   * Subscribes a listener to state changes.
   * @param {(state: CallerSnapshotFrom<TMachine>) => void} listener - The listener function to be called on state changes.
   * @returns {() => void} A function to unsubscribe the listener.
   */
  const subscribe = (listener: (state: CallerSnapshotFrom<TMachine>) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /**
   * Mock connect method.
   * @returns {Promise<void>} A promise that resolves immediately.
   */
  const connect = async () => {
    // Mock implementation, resolves immediately
    return Promise.resolve();
  };

  /**
   * Mock disconnect method.
   */
  const disconnect = () => {
    // Mock implementation, does nothing
  };

  /**
   * Waits for a state condition to be met.
   * @param {(state: CallerSnapshotFrom<TMachine>) => boolean} predicateFn - Function that returns true when condition is met
   * @param {number} [timeoutMs=5000] - Maximum time to wait in milliseconds
   * @returns {Promise<void>} Resolves when condition is met, rejects on timeout
   */
  const waitFor = async (
    predicateFn: (state: CallerSnapshotFrom<TMachine>) => boolean,
    timeoutMs: number = 5000
  ): Promise<void> => {
    // Check if condition is already met
    if (predicateFn(currentSnapshot)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let timeoutId: number | null = null;

      // Set up timeout to reject if condition isn't met in time
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for condition after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      // Subscribe to state changes
      const unsubscribe = subscribe((state) => {
        if (predicateFn(state)) {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          unsubscribe();
          resolve();
        }
      });
    });
  };

  return {
    connect,
    disconnect,
    send,
    getState,
    subscribe,
    produce: produceFn,
    waitFor,
  };
}
