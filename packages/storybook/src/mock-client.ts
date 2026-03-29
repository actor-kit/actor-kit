/**
 * createMockClient — creates a mock ActorClient for Storybook stories.
 *
 * Provides initial view data without a real WebSocket connection.
 * Supports send() for interactive play function testing.
 */

import type { ActorClient, ConnectionState } from "@actor-kit/client";

interface MockClientOptions<TView, TEvent extends { type: string }> {
  /** Initial view data to render */
  initialView: TView;
  /** Initial role (default: "user") */
  role?: string | undefined;
  /** Connection state (default: "connected") */
  connectionState?: ConnectionState | undefined;
  /** Optional handler for send — use in play functions to test interactions */
  onSend?: ((event: TEvent) => TView | void) | undefined;
}

export function createMockClient<
  TView,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
>(options: MockClientOptions<TView, TEvent>): ActorClient<TView, TEvent> {
  const { initialView, role = "user", connectionState = "connected", onSend } = options;

  let currentView = initialView;
  let currentRole = role;
  let currentState: ConnectionState = connectionState;
  const viewListeners = new Set<(view: TView) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  return {
    get connectionState() {
      return currentState;
    },
    get view() {
      return currentView;
    },
    get role() {
      return currentRole;
    },
    subscribe(listener: (view: TView) => void): () => void {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },
    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    send(event: TEvent) {
      if (onSend) {
        const nextView = onSend(event);
        if (nextView !== undefined) {
          currentView = nextView;
          for (const listener of viewListeners) {
            listener(currentView);
          }
        }
      }
    },
    trigger(type: string, payload?: Record<string, unknown>) {
      // trigger() bypasses type safety by design — it constructs an untyped event
      // from string + payload. The real client has the same escape hatch.
      const event: TEvent = Object.assign({ type }, payload) as TEvent;
      this.send(event);
    },
    disconnect() {
      currentState = "disconnected";
      for (const listener of stateListeners) {
        listener(currentState);
      }
    },
  };
}
