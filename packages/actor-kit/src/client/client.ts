/**
 * Client SDK — connects to an actor via WebSocket and provides
 * subscribe/send/trigger API with automatic reconnection.
 *
 * Handles both binary frames (Phase 2) and JSON fallback (Phase 1).
 * Browser-safe: no CF deps.
 */

import { decode } from "../schema/binary";
import { applyDelta } from "../schema/delta";
import { FrameType, parseFrame } from "../schema/frame";
import type { FieldDescriptor, SchemaDefinition } from "../schema/schema";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface ActorClient {
  readonly connectionState: ConnectionState;
  readonly view: unknown;
  readonly role: string | undefined;
  subscribe(listener: (view: unknown) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  send(event: { type: string; [key: string]: unknown }): void;
  trigger(type: string, payload?: Record<string, unknown>): void;
  disconnect(): void;
}

interface ClientOptions {
  actorType: string;
  actorId: string;
  host: string;
  accessToken: string;
  /** Schema for decoding binary frames. If not provided, falls back to JSON. */
  viewSchema?: SchemaDefinition<Record<string, FieldDescriptor>>;
  /** Role names in definition order (for mapping roleIndex to role name) */
  roleNames?: string[];
  WebSocketImpl?: typeof WebSocket;
  onRedirect?: ((target: { actorType: string; actorId: string }) => void) | undefined;
  onError?: ((error: { message: string; error: string }) => void) | undefined;
  maxReconnectAttempts?: number;
}

export function createActorClient(options: ClientOptions): ActorClient {
  const {
    actorType,
    actorId,
    host,
    accessToken,
    viewSchema,
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

  function handleBinaryMessage(data: ArrayBuffer) {
    try {
      const bytes = new Uint8Array(data);
      const frame = parseFrame(bytes);

      if (frame.type === FrameType.SNAPSHOT) {
        if (viewSchema) {
          currentView = decode(viewSchema, frame.payload);
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
        // Apply delta to current view — only changed fields
        if (viewSchema && currentView) {
          currentView = applyDelta(viewSchema, currentView as Record<string, unknown>, frame.payload);
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
                actorType: typeof ctrl.actorType === "string" ? ctrl.actorType : actorType,
                actorId: typeof ctrl.actorId === "string" ? ctrl.actorId : actorId,
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
          actorType: typeof msgObj["actorType"] === "string" ? msgObj["actorType"] : actorType,
          actorId: typeof msgObj["actorId"] === "string" ? msgObj["actorId"] : actorId,
        });
      } else if (msgObj["type"] === "__reconnect_ack") {
        // Server confirmed our checksum matches — no data needed
        setConnectionState("connected");
      } else if (msgObj["type"] === "__error") {
        const errorData = {
          message: typeof msgObj["message"] === "string" ? msgObj["message"] : "",
          error: typeof msgObj["error"] === "string" ? msgObj["error"] : typeof msgObj["detail"] === "string" ? msgObj["detail"] : "unknown",
        };
        onError?.(errorData);
      }
    } catch {
      // Invalid JSON
    }
  }

  function connect() {
    const encodedActorId = encodeURIComponent(actorId);
    // Detect protocol from host — support http://, https://, or bare hostname
    let wsProtocol = "wss:";
    let wsHost = host;
    if (host.startsWith("http://")) {
      wsProtocol = "ws:";
      wsHost = host.slice(7);
    } else if (host.startsWith("https://")) {
      wsProtocol = "wss:";
      wsHost = host.slice(8);
    }
    const url = `${wsProtocol}//${wsHost}/api/${actorType}/${encodedActorId}`;
    ws = new WebSocketImpl(url, [`token.${accessToken}`]);

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
      }
    },
    trigger(type: string, payload?: Record<string, unknown>) {
      this.send({ type, ...payload });
    },
    disconnect() {
      intentionalClose = true;
      connectionState = "disconnected";
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      ws?.close();
    },
  };
}
