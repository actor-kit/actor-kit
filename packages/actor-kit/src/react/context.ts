/**
 * React SDK — createActorContext() provides Provider + hooks for actor state.
 *
 * Usage:
 *   const TodoContext = createActorContext("todo-list");
 *
 *   <TodoContext.Provider actorId="my-list" host="example.com" accessToken={jwt}>
 *     <TodoList />
 *   </TodoContext.Provider>
 *
 *   function TodoList() {
 *     const view = TodoContext.useView();
 *     const send = TodoContext.useSend();
 *     const role = TodoContext.useRole();
 *   }
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createActorClient, type ActorClient, type ConnectionState } from "../client/client";

// --- Types ---

interface ProviderProps {
  actorId: string;
  host: string;
  accessToken: string;
  children: ReactNode;
  onRedirect?: (target: { actorType: string; actorId: string }) => void;
}

interface ActorContext {
  Provider: (props: ProviderProps) => ReactNode;
  useView: () => unknown;
  useSend: () => (event: { type: string; [key: string]: unknown }) => void;
  useRole: () => string | undefined;
  useConnectionState: () => ConnectionState;
  useSelector: <T>(selector: (view: unknown) => T, equalityFn?: (a: T, b: T) => boolean) => T;
}

// --- Implementation ---

export function createActorContext(actorType: string): ActorContext {
  const ClientContext = createContext<ActorClient | null>(null);

  function useClient(): ActorClient {
    const client = useContext(ClientContext);
    if (client === null) {
      throw new Error(`useView/useSend/useRole must be used inside <${actorType}.Provider>`);
    }
    return client;
  }

  function Provider({ actorId, host, accessToken, children, onRedirect }: ProviderProps): ReactNode {
    const [client, setClient] = useState<ActorClient | null>(null);

    useEffect(() => {
      const c = createActorClient({
        actorType,
        actorId,
        host,
        accessToken,
        onRedirect,
      });
      setClient(c);

      return () => {
        c.disconnect();
      };
    }, [actorId, host, accessToken]);

    if (client === null) {
      return null;
    }

    return ClientContext.Provider({ value: client, children });
  }

  function useView(): unknown {
    const client = useClient();
    const [view, setView] = useState<unknown>(client.view);

    useEffect(() => {
      // Set initial view if available
      if (client.view !== undefined) {
        setView(client.view);
      }
      return client.subscribe((newView) => {
        setView(newView);
      });
    }, [client]);

    return view;
  }

  function useSend(): (event: { type: string; [key: string]: unknown }) => void {
    const client = useClient();
    // Return a stable reference
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
    }, [client]);

    return role;
  }

  function useConnectionState(): ConnectionState {
    const client = useClient();
    const [state, setState] = useState<ConnectionState>(client.connectionState);

    useEffect(() => {
      // Use onStateChange for real connection events (not just snapshot-driven)
      return client.onStateChange((newState) => {
        setState(newState);
      });
    }, [client]);

    return state;
  }

  function useSelector<T>(
    selector: (view: unknown) => T,
    equalityFn: (a: T, b: T) => boolean = Object.is,
  ): T {
    const client = useClient();
    const [selected, setSelected] = useState<T>(() => selector(client.view));

    useEffect(() => {
      return client.subscribe((view) => {
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
