/**
 * React SDK — createActorContext() provides Provider + hooks for typed actor state.
 *
 * Usage:
 *   type MyView = { count: number };
 *   type MyEvent = { type: "INCREMENT" } | { type: "DECREMENT" };
 *   const CounterCtx = createActorContext<MyView, MyEvent>();
 *
 *   const client = createActorClient<typeof CounterView.shape, MyEvent>({ url, accessToken, viewSchema: CounterView });
 *
 *   <CounterCtx.Provider client={client}>
 *     <Counter />
 *   </CounterCtx.Provider>
 *
 *   function Counter() {
 *     const view = CounterCtx.useView();   // MyView | undefined
 *     const send = CounterCtx.useSend();   // (event: MyEvent) => void
 *   }
 */

import { createContext, createElement, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { ActorClient, ConnectionState } from "@actor-kit/client";

// --- Types ---

interface ProviderProps<TView, TEvent extends { type: string }> {
  client: ActorClient<TView, TEvent>;
  children: ReactNode;
}

interface ActorContext<TView = unknown, TEvent extends { type: string } = { type: string; [key: string]: unknown }> {
  Provider: (props: ProviderProps<TView, TEvent>) => ReactNode;
  useView: () => TView | undefined;
  useSend: () => (event: TEvent) => void;
  useRole: () => string | undefined;
  useConnectionState: () => ConnectionState;
  useSelector: <T>(selector: (view: TView | undefined) => T, equalityFn?: (a: T, b: T) => boolean) => T;
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

  function useView(): TView | undefined {
    const client = useClient();
    const [view, setView] = useState<TView | undefined>(client.view);

    useEffect(() => {
      if (client.view !== undefined) {
        setView(client.view);
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

  function useSelector<T>(
    selector: (view: TView | undefined) => T,
    equalityFn: (a: T, b: T) => boolean = Object.is,
  ): T {
    const client = useClient();
    const [selected, setSelected] = useState<T>(() => selector(client.view));

    useEffect(() => {
      return client.subscribe((view: TView) => {
        const next = selector(view);
        setSelected((prev) => (equalityFn(prev, next) ? prev : next));
      });
    }, [client, selector, equalityFn]);

    return selected;
  }

  return {
    Provider,
    useView,
    useSend,
    useRole,
    useConnectionState,
    useSelector,
  };
}
