/**
 * Client SDK — connects to an actor via WebSocket and provides
 * subscribe/send/trigger API with automatic reconnection.
 *
 * Handles both binary frames (Phase 2) and JSON fallback (Phase 1).
 * Browser-safe: no CF deps.
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "@actor-kit/core";
import { applyDelta, decode, FrameType, parseFrame } from "@actor-kit/core";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface ActorClient<
  TView = unknown,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
> {
  readonly connectionState: ConnectionState;
  readonly view: TView | undefined;
  readonly role: string | undefined;
  subscribe(listener: (view: TView) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  send(event: TEvent): void;
  trigger(type: string, payload?: Record<string, unknown>): void;
  disconnect(): void;
}

interface ClientOptions {
  /** Full WebSocket URL (e.g., "wss://example.com/game/zones/forest") */
  url: string;
  accessToken?: string | undefined;
  /** Schema for decoding binary frames. If not provided, falls back to JSON. */
  viewSchema?: SchemaDefinition<Record<string, FieldDescriptor>> | undefined;
  /** Per-role schemas for binary decoding (contract-derived). Takes precedence over viewSchema. */
  viewSchemas?: Record<string, SchemaDefinition<Record<string, FieldDescriptor>>> | undefined;
  /** Role names in definition order (for mapping roleIndex to role name) */
  roleNames?: string[] | undefined;
  WebSocketImpl?: typeof WebSocket;
  onRedirect?: ((target: { actorType: string; actorId: string }) => void) | undefined;
  onError?: ((error: { message: string; error: string }) => void) | undefined;
  maxReconnectAttempts?: number | undefined;
}

// Overload: with viewSchema → view type inferred, TEvent explicit
export function createActorClient<
  TShape extends Record<string, FieldDescriptor>,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
>(
  options: ClientOptions & { viewSchema: SchemaDefinition<TShape> },
): ActorClient<Infer<SchemaDefinition<TShape>>, TEvent>;

// Overload: without viewSchema → unknown view
export function createActorClient(options: ClientOptions): ActorClient;

// Implementation
export function createActorClient(options: ClientOptions): ActorClient<unknown> {
  const {
    url,
    accessToken,
    viewSchema,
    viewSchemas,
    roleNames,
    WebSocketImpl = WebSocket,
    onRedirect,
    onError,
    maxReconnectAttempts = 10,
  } = options;

  let connectionState: ConnectionState = "connecting";
  let currentView: unknown;
  let currentRole: string | undefined;
  const listeners = new Set<(view: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let ws: InstanceType<typeof WebSocketImpl> | undefined;
  let intentionalClose = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastChecksum: string | undefined;
  let isReconnecting = false;
  let activeSchema: SchemaDefinition<Record<string, FieldDescriptor>> | undefined = viewSchema;
  const messageQueue: Array<{ type: string; [key: string]: unknown }> = [];

  function computeChecksum(json: string): string {
    let h = 0;
    for (let i = 0; i < json.length; i++) {
      h = ((h << 5) - h + json.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function notifyListeners() {
    for (const listener of listeners) {
      listener(currentView);
    }
  }

  function setConnectionState(newState: ConnectionState) {
    if (newState === connectionState) return;
    connectionState = newState;
    for (const listener of stateListeners) {
      listener(newState);
    }
  }

  /** Resolve the binary schema for a given roleIndex. Per-role schemas take precedence. */
  function resolveSchema(roleIndex: number | undefined): SchemaDefinition<Record<string, FieldDescriptor>> | undefined {
    if (viewSchemas && roleNames && roleIndex !== undefined) {
      const roleName = roleNames[roleIndex];
      if (roleName !== undefined && roleName in viewSchemas) {
        return viewSchemas[roleName];
      }
    }
    return viewSchema;
  }

  function handleBinaryMessage(data: ArrayBuffer) {
    try {
      const bytes = new Uint8Array(data);
      const frame = parseFrame(bytes);

      if (frame.type === FrameType.SNAPSHOT) {
        const resolved = resolveSchema(frame.roleIndex);
        if (resolved) {
          activeSchema = resolved;
          currentView = decode(resolved, frame.payload);
        } else {
          return;
        }
        if (roleNames && frame.roleIndex !== undefined) {
          currentRole = roleNames[frame.roleIndex];
        }
        // Store checksum for reconnection
        lastChecksum = computeChecksum(JSON.stringify(currentView));
        setConnectionState("connected");
        notifyListeners();
      } else if (frame.type === FrameType.DELTA) {
        // Apply delta to current view using the schema from the last snapshot
        if (activeSchema && currentView) {
          currentView = applyDelta(activeSchema, currentView as Record<string, unknown>, frame.payload);
          lastChecksum = computeChecksum(JSON.stringify(currentView));
          notifyListeners();
        }
      } else if (frame.type === FrameType.CONTROL && frame.controlType !== undefined) {
        // Handle control frames (redirect, error, etc.)
        const controlPayload = new TextDecoder().decode(frame.payload);
        try {
          const ctrl = JSON.parse(controlPayload);
          if (typeof ctrl === "object" && ctrl !== null) {
            if ("actorType" in ctrl || "actorId" in ctrl) {
              onRedirect?.({
                actorType: typeof ctrl.actorType === "string" ? ctrl.actorType : "",
                actorId: typeof ctrl.actorId === "string" ? ctrl.actorId : "",
              });
            }
          }
        } catch {
          // Invalid control payload
        }
      }
    } catch {
      // Binary decode error — ignore
    }
  }

  function handleJsonMessage(data: string) {
    try {
      const msg: unknown = JSON.parse(data);
      if (typeof msg !== "object" || msg === null) return;

      const msgObj = msg as Record<string, unknown>;

      if (msgObj["type"] === "snapshot") {
        currentView = msgObj["data"];
        currentRole = typeof msgObj["role"] === "string" ? msgObj["role"] : currentRole;
        setConnectionState("connected");
        notifyListeners();
      } else if (msgObj["type"] === "__redirect") {
        onRedirect?.({
          actorType: typeof msgObj["actorType"] === "string" ? msgObj["actorType"] : "",
          actorId: typeof msgObj["actorId"] === "string" ? msgObj["actorId"] : "",
        });
      } else if (msgObj["type"] === "__reconnect_ack") {
        // Server confirmed our checksum matches — no data needed
        setConnectionState("connected");
      } else if (msgObj["type"] === "__error") {
        const errorData = {
          message: typeof msgObj["message"] === "string" ? msgObj["message"] : "",
          error:
            typeof msgObj["error"] === "string"
              ? msgObj["error"]
              : typeof msgObj["detail"] === "string"
                ? msgObj["detail"]
                : "unknown",
        };
        onError?.(errorData);
      }
    } catch {
      // Invalid JSON
    }
  }

  function connect() {
    ws = accessToken ? new WebSocketImpl(url, [`token.${accessToken}`]) : new WebSocketImpl(url);

    // Request ArrayBuffer for binary frames (browsers default to Blob)
    if ("binaryType" in ws) {
      (ws as { binaryType: string }).binaryType = "arraybuffer";
    }

    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      // If reconnecting with a previous checksum, send reconnect handshake
      if (isReconnecting && lastChecksum) {
        ws?.send(JSON.stringify({ type: "__reconnect", lastChecksum }));
        isReconnecting = false;
      }
      // Flush queued messages that were sent during reconnection
      while (messageQueue.length > 0) {
        const queued = messageQueue.shift();
        if (queued && ws && ws.readyState === 1) {
          ws.send(JSON.stringify(queued));
        }
      }
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryMessage(event.data);
      } else if (typeof event.data === "string") {
        handleJsonMessage(event.data);
      }
    });

    ws.addEventListener("close", () => {
      if (intentionalClose) {
        setConnectionState("disconnected");
        return;
      }

      if (reconnectAttempts < maxReconnectAttempts) {
        setConnectionState("reconnecting");
        isReconnecting = true;
        const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(() => {
          connect();
        }, delay);
      } else {
        setConnectionState("disconnected");
      }
    });

    ws.addEventListener("error", () => {
      // Error triggers close, which handles reconnection
    });
  }

  connect();

  return {
    get connectionState() {
      return connectionState;
    },
    get view() {
      return currentView;
    },
    get role() {
      return currentRole;
    },
    subscribe(listener: (view: unknown) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    send(event: { type: string; [key: string]: unknown }) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(event));
      } else if (connectionState === "reconnecting" || connectionState === "connecting") {
        messageQueue.push(event);
      }
    },
    trigger(type: string, payload?: Record<string, unknown>) {
      this.send({ type, ...payload });
    },
    disconnect() {
      intentionalClose = true;
      connectionState = "disconnected";
      messageQueue.length = 0;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      ws?.close();
    },
  };
}
