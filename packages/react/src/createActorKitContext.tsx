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
import { matchesState, StateValueFrom } from "xstate";
import type { ActorKitClientProps } from "@actor-kit/browser";
import { createActorKitClient } from "@actor-kit/browser";
import type {
  ActorKitClient,
  AnyActorKitStateMachine,
  CallerSnapshotFrom,
  ClientEventFrom,
  MatchesProps,
} from "@actor-kit/types";

export function createActorKitContext<TMachine extends AnyActorKitStateMachine>(
  actorType: string
) {
  const ActorKitContext = createContext<ActorKitClient<TMachine> | null>(null);

  const ProviderFromClient: React.FC<{
    children: ReactNode;
    client: ActorKitClient<TMachine>;
  }> = ({ children, client }) => {
    return (
      <ActorKitContext.Provider value={client}>
        {children}
      </ActorKitContext.Provider>
    );
  };

  const InitialSnapshotContext = createContext<CallerSnapshotFrom<TMachine> | null>(null);

  const Provider: React.FC<
    {
      children: ReactNode;
    } & Omit<ActorKitClientProps<TMachine>, "actorType">
  > = memo((props) => {
    const clientRef = useRef(
      createActorKitClient<TMachine>({
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

  function useClient(): ActorKitClient<TMachine> {
    const client = useContext(ActorKitContext);
    if (!client) {
      throw new Error(
        "useClient must be used within an ActorKitContext.Provider"
      );
    }
    return client;
  }

  const useSelector = <T,>(
    selector: (snapshot: CallerSnapshotFrom<TMachine>) => T
  ) => {
    const client = useClient();
    const initialSnapshot = useContext(InitialSnapshotContext);

    // Use the initial snapshot for SSR to ensure hydration stability.
    // The server render uses initialSnapshot, and the client's first render
    // must return the same value to avoid hydration mismatches.
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

  function useSend(): (event: ClientEventFrom<TMachine>) => void {
    const client = useClient();
    return client.send;
  }

  function useMatches(stateValue: StateValueFrom<TMachine>): boolean {
    return useSelector((state) =>
      matchesState(stateValue, state.value as StateValueFrom<TMachine>)
    );
  }

  const Matches: React.FC<MatchesProps<TMachine> & { children: ReactNode }> & {
    create: (
      state: StateValueFrom<TMachine>,
      options?: {
        and?: StateValueFrom<TMachine>;
        or?: StateValueFrom<TMachine>;
        not?: boolean;
      }
    ) => React.FC<
      Omit<MatchesProps<TMachine>, "state" | "and" | "or" | "not"> & {
        children: ReactNode;
      }
    >;
  } = (props) => {
    const active = useMatches(props.state);
    const matchesAnd = props.and ? useMatches(props.and) : true;
    const matchesOr = props.or ? useMatches(props.or) : false;
    const value =
      typeof props.initialValueOverride === "boolean"
        ? props.initialValueOverride
        : (active && matchesAnd) || matchesOr;
    const finalValue = props.not ? !value : value;
    return finalValue ? <>{props.children}</> : null;
  };

  Matches.create = (state, options = {}) => {
    const Component: React.FC<
      Omit<MatchesProps<TMachine>, "state" | "and" | "or" | "not"> & {
        children: ReactNode;
      }
    > = ({ children, initialValueOverride }) => (
      <Matches
        state={state}
        and={options.and}
        or={options.or}
        not={options.not}
        initialValueOverride={initialValueOverride}
      >
        {children}
      </Matches>
    );
    Component.displayName = `MatchesComponent(${state.toString()})`;
    return Component;
  };

  return {
    Provider,
    ProviderFromClient,
    useClient,
    useSelector,
    useSend,
    useMatches,
    Matches,
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
