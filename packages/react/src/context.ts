/**
 * React SDK — createActorContext() provides Provider + hooks for typed actor state.
 *
 * Usage:
 *   type MyView = { count: number };
 *   type MyEvent = { type: "INCREMENT" } | { type: "DECREMENT" };
 *   const CounterCtx = createActorContext<MyView, MyEvent>();
 *
 *   const client = CounterClient.create({ url, initialView: snapshot });
 *
 *   <CounterCtx.Provider client={client}>
 *     <Counter />
 *   </CounterCtx.Provider>
 *
 *   function Counter() {
 *     const view = CounterCtx.useView();   // MyView (never undefined)
 *     const send = CounterCtx.useSend();   // (event: MyEvent) => void
 *   }
 */

import type { ActorClient, ClientOptions, ConnectionState, CreateOptions } from "@actor-kit/client";
import { createActorClient } from "@actor-kit/client";
import { ActorKitError } from "@actor-kit/core";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

// --- Types ---

interface ProviderProps<TView, TEvent extends { type: string }> {
  client: ActorClient<TView, TEvent>;
  children: ReactNode;
}

interface ActorContext<TView = unknown, TEvent extends { type: string } = { type: string; [key: string]: unknown }> {
  Provider: (props: ProviderProps<TView, TEvent>) => ReactNode;
  useClient: (options: CreateOptions<TView>) => ActorClient<TView, TEvent>;
  /** The Provider's client, for work with it directly (subscribe to every change, read `client.view` in an effect). */
  useActorClient: () => ActorClient<TView, TEvent>;
  useView: () => TView;
  useSend: () => (event: TEvent) => void;
  useRole: () => string | undefined;
  useConnectionState: () => ConnectionState;
  useSelector: <T>(selector: (view: TView) => T, equalityFn?: (a: T, b: T) => boolean) => T;
}

// --- Implementation ---

export function createActorContext<
  TView = unknown,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
>(
  /** How `useClient` decodes binary views (a contract's role names and view schemas). */
  decoding?: Pick<ClientOptions, "roleNames" | "viewSchemas">,
): ActorContext<TView, TEvent> {
  const ClientContext = createContext<ActorClient<TView, TEvent> | null>(null);

  function useClient(): ActorClient<TView, TEvent> {
    const client = useContext(ClientContext);
    if (client === null) {
      throw new ActorKitError(
        "missing_provider",
        "useView/useSend/useRole must be used inside <Provider>: render the component inside its actor context's Provider.",
      );
    }
    return client;
  }

  function Provider({ client, children }: ProviderProps<TView, TEvent>): ReactNode {
    return createElement(ClientContext.Provider, { value: client }, children);
  }

  function useView(): TView {
    const client = useClient();
    // Renders read the client's view itself, so a render never shows an older view or another
    // client's; the subscription only asks for a render.
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    const rendered = client.view;
    // biome-ignore lint/correctness/useExhaustiveDependencies: compares with the view of the render that subscribed
    useEffect(() => {
      // Catch up with a view that changed between render and subscribe.
      if (client.view !== rendered) rerender();
      return client.subscribe(() => rerender());
    }, [client]);
    return rendered;
  }

  // Role, connection state and selections read through useSyncExternalStore: what renders is the
  // client's value at render time, also when it changed between render and subscribe or the
  // Provider was given another client.
  function useSend(): (event: TEvent) => void {
    const client = useClient();
    const sendRef = useRef(client.send.bind(client));
    sendRef.current = client.send.bind(client);
    return sendRef.current;
  }

  function useRole(): string | undefined {
    const client = useClient();
    // A role changes with a view frame, so the view subscription carries it.
    const subscribe = useCallback((onChange: () => void) => client.subscribe(onChange), [client]);
    const read = () => client.role;
    return useSyncExternalStore(subscribe, read, read);
  }

  function useConnectionState(): ConnectionState {
    const client = useClient();
    const subscribe = useCallback((onChange: () => void) => client.onStateChange(onChange), [client]);
    const read = () => client.connectionState;
    return useSyncExternalStore(subscribe, read, read);
  }

  function useSelector<T>(selector: (view: TView) => T, equalityFn: (a: T, b: T) => boolean = Object.is): T {
    const client = useClient();
    const subscribe = useCallback((onChange: () => void) => client.subscribe(onChange), [client]);
    // The last selection: kept while the view and selector are the same, and while equalityFn says
    // a new selection equals it (so an unrelated frame does not re-render with a new object).
    const last = useRef<{ view: TView; selector: (view: TView) => T; selected: T } | null>(null);
    const read = () => {
      const view = client.view;
      const previous = last.current;
      if (previous !== null && previous.view === view && previous.selector === selector) return previous.selected;
      const next = selector(view);
      const selected = previous !== null && equalityFn(previous.selected, next) ? previous.selected : next;
      last.current = { view, selector, selected };
      return selected;
    };
    return useSyncExternalStore(subscribe, read, read);
  }

  function useClientHook(options: CreateOptions<TView>): ActorClient<TView, TEvent> {
    // One client per room: a new path or host is another room, so it gets its own client (and the
    // effect below disconnects the old one). Other options are read when the room's client is made.
    const room = `${options.host ?? ""}|${options.path}`;
    const [owned, setOwned] = useState(() => ({
      room,
      client: createActorClient<TView, TEvent>({ ...options, ...decoding }),
    }));
    let client = owned.client;
    if (owned.room !== room) {
      client = createActorClient<TView, TEvent>({ ...options, ...decoding });
      setOwned({ room, client });
    }

    useEffect(() => {
      client.connect();
      return () => {
        client.disconnect();
      };
    }, [client]);

    return client;
  }

  return {
    Provider,
    useClient: useClientHook,
    useActorClient: useClient,
    useView,
    useSend,
    useRole,
    useConnectionState,
    useSelector,
  };
}
