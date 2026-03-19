/**
 * Framework-agnostic selector for ActorKitClient.
 *
 * Subscribes to client state internally, compares selected value on
 * each update, and only notifies subscribers when it actually changes.
 */
export type ActorKitSelector<T> = {
  /** Get the current selected value. */
  get(): T;
  /** Subscribe — only fires when the selected value changes. Returns unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
};

/**
 * Creates a selector that derives a value from client state.
 *
 * @param getState - Returns the current full snapshot
 * @param subscribeToClient - Subscribes to all state changes on the client
 * @param selectorFn - Extracts the desired slice from the snapshot
 * @param equalityFn - Optional custom equality (default: Object.is)
 */
export function createSelector<TSnapshot, TSelected>(
  getState: () => TSnapshot,
  subscribeToClient: (listener: (state: TSnapshot) => void) => () => void,
  selectorFn: (state: TSnapshot) => TSelected,
  equalityFn: (a: TSelected, b: TSelected) => boolean = Object.is
): ActorKitSelector<TSelected> {
  let currentValue = selectorFn(getState());
  const listeners = new Set<(value: TSelected) => void>();

  // Subscribe to the client once — shared across all selector subscribers
  let clientUnsub: (() => void) | null = null;
  let refCount = 0;

  function ensureSubscribed() {
    if (clientUnsub) return;
    clientUnsub = subscribeToClient((state) => {
      const nextValue = selectorFn(state);
      if (!equalityFn(currentValue, nextValue)) {
        currentValue = nextValue;
        listeners.forEach((l) => l(currentValue));
      }
    });
  }

  function maybeUnsubscribe() {
    if (refCount === 0 && clientUnsub) {
      clientUnsub();
      clientUnsub = null;
    }
  }

  return {
    get() {
      // Always recompute from current state to stay fresh
      currentValue = selectorFn(getState());
      return currentValue;
    },

    subscribe(listener: (value: TSelected) => void) {
      listeners.add(listener);
      refCount++;
      ensureSubscribed();

      return () => {
        listeners.delete(listener);
        refCount--;
        maybeUnsubscribe();
      };
    },
  };
}
