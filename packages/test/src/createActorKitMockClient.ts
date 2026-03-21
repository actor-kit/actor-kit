import { Draft, produce } from "immer";
import { createSelector } from "@actor-kit/browser";
import type {
  ActorKitClient,
  ActorKitSelector,
  TriggerAPI,
} from "@actor-kit/browser";

export type ActorKitMockClientProps<
  TView,
  TEvent extends { type: string },
> = {
  initialSnapshot: TView;
  onSend?: (event: TEvent) => void;
};

export type ActorKitMockClient<
  TView,
  TEvent extends { type: string },
> = ActorKitClient<TView, TEvent> & {
  produce: (recipe: (draft: Draft<TView>) => void) => void;
};

export function createActorKitMockClient<
  TView,
  TEvent extends { type: string },
>(
  props: ActorKitMockClientProps<TView, TEvent>
): ActorKitMockClient<TView, TEvent> {
  let currentSnapshot = props.initialSnapshot;
  const listeners: Set<(state: TView) => void> = new Set();

  const notifyListeners = () => {
    listeners.forEach((listener) => listener(currentSnapshot));
  };

  const produceFn = (recipe: (draft: Draft<TView>) => void) => {
    currentSnapshot = produce(currentSnapshot, recipe);
    notifyListeners();
  };

  const send = (event: TEvent) => {
    props.onSend?.(event);
    notifyListeners();
  };

  const getState = () => currentSnapshot;

  const subscribe = (listener: (state: TView) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const connect = async () => {};

  const disconnect = () => {};

  const waitFor = async (
    predicateFn: (state: TView) => boolean,
    timeoutMs: number = 5000
  ): Promise<void> => {
    if (predicateFn(currentSnapshot)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for condition after ${timeoutMs}ms`));
        }, timeoutMs);
      }

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

  const trigger = new Proxy({} as TriggerAPI<TEvent>, {
    get(_target, eventType: string) {
      return (payload?: Record<string, unknown>) => {
        send({ type: eventType, ...payload } as TEvent);
      };
    },
  });

  const select = <TSelected>(
    selectorFn: (state: TView) => TSelected,
    equalityFn?: (a: TSelected, b: TSelected) => boolean
  ): ActorKitSelector<TSelected> =>
    createSelector(getState, subscribe, selectorFn, equalityFn);

  return {
    connect,
    disconnect,
    send,
    getState,
    subscribe,
    produce: produceFn,
    waitFor,
    select,
    trigger,
  };
}
