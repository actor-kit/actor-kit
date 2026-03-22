"use client";

import React, {
  createContext,
  memo,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ActorKitClientProps, ActorKitClient } from "@actor-kit/browser";
import { createActorKitClient } from "@actor-kit/browser";

export function createActorKitContext<
  TView,
  TEvent extends { type: string } = { type: string },
>(actorType: string) {
  const ActorKitContext = createContext<ActorKitClient<TView, TEvent> | null>(null);

  const ProviderFromClient: React.FC<{
    children: ReactNode;
    client: ActorKitClient<TView, TEvent>;
  }> = ({ children, client }) => {
    return (
      <ActorKitContext.Provider value={client}>
        {children}
      </ActorKitContext.Provider>
    );
  };

  const InitialSnapshotContext = createContext<TView | null>(null);

  const Provider: React.FC<
    {
      children: ReactNode;
    } & Omit<ActorKitClientProps<TView, TEvent>, "actorType">
  > = memo((props) => {
    const clientRef = useRef(
      createActorKitClient<TView, TEvent>({
        host: props.host,
        actorId: props.actorId,
        accessToken: props.accessToken,
        checksum: props.checksum,
        initialSnapshot: props.initialSnapshot,
        actorType,
      })
    );
    const initializedRef = useRef(false);

    useEffect(() => {
      if (!initializedRef.current) {
        initializedRef.current = true;
        clientRef.current.connect().then(() => {});
      }
    }, [initializedRef]);

    return (
      <InitialSnapshotContext.Provider value={props.initialSnapshot}>
        <ActorKitContext.Provider value={clientRef.current}>
          {props.children}
        </ActorKitContext.Provider>
      </InitialSnapshotContext.Provider>
    );
  });

  function useClient(): ActorKitClient<TView, TEvent> {
    const client = useContext(ActorKitContext);
    if (!client) {
      throw new Error(
        "useClient must be used within an ActorKitContext.Provider"
      );
    }
    return client;
  }

  const useSelector = <T,>(selector: (snapshot: TView) => T) => {
    const client = useClient();
    const initialSnapshot = useContext(InitialSnapshotContext);

    const getServerSnapshot = useMemo(() => {
      if (!initialSnapshot) return undefined;
      return () => initialSnapshot;
    }, [initialSnapshot]);

    return useSyncExternalStoreWithSelector(
      client.subscribe,
      client.getState,
      getServerSnapshot,
      selector,
      defaultCompare
    );
  };

  function useSend(): (event: TEvent) => void {
    const client = useClient();
    return client.send;
  }

  return {
    Provider,
    ProviderFromClient,
    useClient,
    useSelector,
    useSend,
  };
}

function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean
): Selection {
  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot) => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        memoizedSelection = selector(nextSnapshot);
        return memoizedSelection;
      }

      if (Object.is(memoizedSnapshot, nextSnapshot)) {
        return memoizedSelection;
      }

      const nextSelection = selector(nextSnapshot);

      if (isEqual && isEqual(memoizedSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return memoizedSelection;
      }

      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };

    const getSnapshotWithSelector = () => memoizedSelector(getSnapshot());
    const getServerSnapshotWithSelector = getServerSnapshot
      ? () => memoizedSelector(getServerSnapshot())
      : undefined;

    return [getSnapshotWithSelector, getServerSnapshotWithSelector];
  }, [getSnapshot, getServerSnapshot, selector, isEqual]);

  const subscribeWithSelector = useCallback(
    (onStoreChange: () => void) => {
      let previousSelection = getSelection();
      return subscribe(() => {
        const nextSelection = getSelection();
        if (!isEqual || !isEqual(previousSelection, nextSelection)) {
          previousSelection = nextSelection;
          onStoreChange();
        }
      });
    },
    [subscribe, getSelection, isEqual]
  );

  return useSyncExternalStore(
    subscribeWithSelector,
    getSelection,
    getServerSelection
  );
}

function defaultCompare<T>(a: T, b: T) {
  return a === b;
}
