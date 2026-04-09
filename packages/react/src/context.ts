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

import type { ActorClient, ConnectionState, CreateOptions } from "@actor-kit/client";
import { createActorClient } from "@actor-kit/client";
import { createContext, createElement, type ReactNode, useContext, useEffect, useRef, useState } from "react";

// --- Types ---

interface ProviderProps<TView, TEvent extends { type: string }> {
  client: ActorClient<TView, TEvent>;
  children: ReactNode;
}

interface ActorContext<TView = unknown, TEvent extends { type: string } = { type: string; [key: string]: unknown }> {
  Provider: (props: ProviderProps<TView, TEvent>) => ReactNode;
  useClient: (options: CreateOptions<TView>) => ActorClient<TView, TEvent>;
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
>(): ActorContext<TView, TEvent> {
  const ClientContext = createContext<ActorClient<TView, TEvent> | null>(null);

  function useClient(): ActorClient<TView, TEvent> {
    const client = useContext(ClientContext);
    if (client === null) {
      throw new Error("useView/useSend/useRole must be used inside <Provider>");
    }
    return client;
  }

  function Provider({ client, children }: ProviderProps<TView, TEvent>): ReactNode {
    return createElement(ClientContext.Provider, { value: client }, children);
  }

  function useView(): TView {
    const client = useClient();
    const [view, setView] = useState<TView>(() => client.view as TView);

    useEffect(() => {
      if (client.view !== undefined) {
        setView(client.view as TView);
      }
      return client.subscribe((newView: TView) => {
        setView(newView);
      });
    }, [client]);

    return view;
  }

  function useSend(): (event: TEvent) => void {
    const client = useClient();
    const sendRef = useRef(client.send.bind(client));
    sendRef.current = client.send.bind(client);
    return sendRef.current;
  }

  function useRole(): string | undefined {
    const client = useClient();
    const [role, setRole] = useState<string | undefined>(client.role);

    useEffect(() => {
      return client.subscribe(() => {
        if (client.role !== role) {
          setRole(client.role);
        }
      });
    }, [client, role]);

    return role;
  }

  function useConnectionState(): ConnectionState {
    const client = useClient();
    const [state, setState] = useState<ConnectionState>(client.connectionState);

    useEffect(() => {
      return client.onStateChange((newState) => {
        setState(newState);
      });
    }, [client]);

    return state;
  }

  function useSelector<T>(selector: (view: TView) => T, equalityFn: (a: T, b: T) => boolean = Object.is): T {
    const client = useClient();
    const [selected, setSelected] = useState<T>(() => selector(client.view as TView));

    useEffect(() => {
      return client.subscribe((view: TView) => {
        const next = selector(view);
        setSelected((prev) => (equalityFn(prev, next) ? prev : next));
      });
    }, [client, selector, equalityFn]);

    return selected;
  }

  function useClientHook(options: CreateOptions<TView>): ActorClient<TView, TEvent> {
    const [client] = useState(() => createActorClient<TView, TEvent>(options));

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
    useView,
    useSend,
    useRole,
    useConnectionState,
    useSelector,
  };
}
