import type { Operation } from "fast-json-patch";
import { applyPatch } from "fast-json-patch";
import { produce } from "immer";
import { z } from "zod";

import type { ActorKitSelector } from "./selector";
import { createSelector } from "./selector";

/**
 * Validates an emitted event from the actor-kit WebSocket protocol.
 *
 * The Zod schema validates `op` is a valid JSON Patch operation string,
 * then transforms the output to `Operation[]` from fast-json-patch.
 * This is safe because Zod has validated the `op` values match the
 * discriminated union variants — the transform bridges Zod's flat
 * object output to fast-json-patch's discriminated union type.
 */
const EmittedEventSchema = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum([
          "add",
          "remove",
          "replace",
          "move",
          "copy",
          "test",
          "_get",
        ]),
        path: z.string(),
        value: z.unknown().optional(),
        from: z.string().optional(),
      })
    )
    .transform((ops): Operation[] => ops as unknown as Operation[]),
  checksum: z.string(),
});

/**
 * Maps a union of event objects into a trigger API:
 *   { type: "FOO"; x: number } | { type: "BAR" }
 *   →  { FOO(payload: { x: number }): void; BAR(): void }
 */
export type TriggerAPI<TEvent extends { type: string }> = {
  [K in TEvent["type"]]: Omit<
    Extract<TEvent, { type: K }>,
    "type"
  > extends Record<string, never>
    ? () => void
    : (payload: Omit<Extract<TEvent, { type: K }>, "type">) => void;
};

export type ActorKitClient<TView, TEvent extends { type: string }> = {
  connect: () => Promise<void>;
  disconnect: () => void;
  send: (event: TEvent) => void;
  getState: () => TView;
  subscribe: (listener: (state: TView) => void) => () => void;
  waitFor: (
    predicateFn: (state: TView) => boolean,
    timeoutMs?: number
  ) => Promise<void>;
  select: <TSelected>(
    selector: (state: TView) => TSelected,
    equalityFn?: (a: TSelected, b: TSelected) => boolean
  ) => ActorKitSelector<TSelected>;
  trigger: TriggerAPI<TEvent>;
};

export type ActorKitClientProps<TView, TEvent extends { type: string }> = {
  host: string;
  actorType: string;
  actorId: string;
  checksum: string;
  accessToken: string;
  initialSnapshot: TView;
  onStateChange?: (newState: TView) => void;
  onError?: (error: Error) => void;
};

type Listener<T> = (state: T) => void;

/**
 * Creates an Actor Kit client for managing state and communication with the server.
 *
 * @template TView - The type of the client view/snapshot.
 * @template TEvent - The type of client events.
 * @param {ActorKitClientProps<TView, TEvent>} props - Configuration options for the client.
 * @returns {ActorKitClient<TView, TEvent>} An object with methods to interact with the actor.
 */
export function createActorKitClient<TView, TEvent extends { type: string }>(
  props: ActorKitClientProps<TView, TEvent>
): ActorKitClient<TView, TEvent> {
  let currentSnapshot = props.initialSnapshot;
  let socket: WebSocket | null = null;

  let shouldReconnect = true;
  const listeners: Set<Listener<TView>> = new Set();
  const pendingEvents: TEvent[] = [];
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  const maxQueueSize = 100;

  /**
   * Notifies all registered listeners with the current state.
   */
  const notifyListeners = () => {
    listeners.forEach((listener) => listener(currentSnapshot));
  };

  /**
   * Establishes a WebSocket connection to the Actor Kit server.
   * @returns {Promise<void>} A promise that resolves when the connection is established.
   */
  const connect = async () => {
    shouldReconnect = true;
    const url = getWebSocketUrl(props);

    socket = new WebSocket(url);


    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      flushPendingEvents();
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = EmittedEventSchema.parse(JSON.parse(
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data)
        ));

        currentSnapshot = produce(currentSnapshot, (draft) => {
          applyPatch(draft, data.operations);
        });

        props.onStateChange?.(currentSnapshot);
        notifyListeners();
      } catch (error: unknown) {
        console.error(`[ActorKitClient] Error processing message:`, error);
        props.onError?.(
          error instanceof Error
            ? error
            : new Error("Unknown WebSocket message error")
        );
      }
    });

    socket.addEventListener("error", (error: Event) => {
      console.error(`[ActorKitClient] WebSocket error:`, error);
      props.onError?.(new Error(`WebSocket error: ${error.type}`));
    });

    // todo, how do we reconnect when a user returns to the tab
    // later after it's disconnected

    socket.addEventListener("close", (_event) => {


      // Implement reconnection logic
      if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(connect, delay);
      } else if (shouldReconnect) {
        console.error(`[ActorKitClient] Max reconnection attempts reached`);
      }
    });

    return new Promise<void>((resolve) => {
      socket!.addEventListener("open", () => resolve());
    });
  };

  /**
   * Closes the WebSocket connection to the Actor Kit server.
   */
  const disconnect = () => {
    shouldReconnect = false;
    if (socket) {
      socket.close();
      socket = null;
    }

  };

  const flushPendingEvents = () => {
    while (socket && socket.readyState === WebSocket.OPEN && pendingEvents.length > 0) {
      const event = pendingEvents.shift();
      if (!event) {
        continue;
      }
      socket.send(JSON.stringify(event));
    }
  };

  /**
   * Sends an event to the Actor Kit server.
   * @param {TEvent} event - The event to send.
   */
  const send = (event: TEvent) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
      return;
    }

    // Queue the event for delivery when connection is (re)established
    if (pendingEvents.length >= maxQueueSize) {
      const dropped = pendingEvents.shift();
      props.onError?.(
        new Error(
          `Event queue overflow: dropped event "${(dropped as { type?: string })?.type ?? "unknown"}". ` +
          `Queue is full at ${maxQueueSize} events while disconnected.`
        )
      );
    }
    pendingEvents.push(event);
  };

  /**
   * Retrieves the current state of the actor.
   * @returns {TView} The current state.
   */
  const getState = () => currentSnapshot;

  /**
   * Subscribes a listener to state changes.
   * @param {Listener<TView>} listener - The listener function to be called on state changes.
   * @returns {() => void} A function to unsubscribe the listener.
   */
  const subscribe = (listener: Listener<TView>) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /**
   * Waits for a state condition to be met.
   * @param {(state: TView) => boolean} predicateFn - Function that returns true when condition is met
   * @param {number} [timeoutMs=5000] - Maximum time to wait in milliseconds
   * @returns {Promise<void>} Resolves when condition is met, rejects on timeout
   */
  const waitFor = async (
    predicateFn: (state: TView) => boolean,
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
          reject(
            new Error(`Timeout waiting for condition after ${timeoutMs}ms`)
          );
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

  const trigger = new Proxy({} as ActorKitClient<TView, TEvent>["trigger"], {
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
    waitFor,
    select,
    trigger,
  };
}

function getWebSocketUrl<TView, TEvent extends { type: string }>(
  props: ActorKitClientProps<TView, TEvent>
): string {
  const { host, actorId, actorType, accessToken, checksum } = props;

  // Determine protocol (ws or wss)
  const protocol =
    /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(
      host
    )
      ? "ws"
      : "wss";

  // Construct base URL
  const baseUrl = `${protocol}://${host}/api/${actorType}/${actorId}`;

  // Add query parameters
  const params = new URLSearchParams({ accessToken });
  if (checksum) params.append("checksum", checksum);

  const finalUrl = `${baseUrl}?${params.toString()}`;

  return finalUrl;
}
