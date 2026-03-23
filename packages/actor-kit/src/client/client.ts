/**
 * Client SDK — connects to an actor via WebSocket and provides
 * subscribe/send/trigger API with automatic reconnection.
 *
 * Handles both binary frames (Phase 2) and JSON fallback (Phase 1).
 * Browser-safe: no CF deps.
 */

import { decode } from "../schema/binary";
import { parseFrame, FrameType } from "../schema/frame";
import type { SchemaDefinition, FieldDescriptor } from "../schema/schema";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface ActorClient {
  readonly connectionState: ConnectionState;
  readonly view: unknown;
  readonly role: string | undefined;
  subscribe(listener: (view: unknown) => void): () => void;
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
    maxReconnectAttempts = 10,
  } = options;

  let connectionState: ConnectionState = "connecting";
  let currentView: unknown = undefined;
  let currentRole: string | undefined = undefined;
  const listeners = new Set<(view: unknown) => void>();
  let ws: InstanceType<typeof WebSocketImpl> | undefined;
  let intentionalClose = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function notifyListeners() {
    for (const listener of listeners) {
      listener(currentView);
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
          // No schema — can't decode binary. This shouldn't happen if properly configured.
          return;
        }
        if (roleNames && frame.roleIndex !== undefined) {
          currentRole = roleNames[frame.roleIndex];
        }
        connectionState = "connected";
        notifyListeners();
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
        connectionState = "connected";
        notifyListeners();
      } else if (msgObj["type"] === "__redirect") {
        onRedirect?.({
          actorType: typeof msgObj["actorType"] === "string" ? msgObj["actorType"] : actorType,
          actorId: typeof msgObj["actorId"] === "string" ? msgObj["actorId"] : actorId,
        });
      } else if (msgObj["type"] === "__error") {
        // Error frame from server
      }
    } catch {
      // Invalid JSON
    }
  }

  function connect() {
    const encodedActorId = encodeURIComponent(actorId);
    const url = `wss://${host}/api/${actorType}/${encodedActorId}`;
    ws = new WebSocketImpl(url, [`token.${accessToken}`]);

    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
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
        connectionState = "disconnected";
        return;
      }

      if (reconnectAttempts < maxReconnectAttempts) {
        connectionState = "reconnecting";
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(() => {
          connect();
        }, delay);
      } else {
        connectionState = "disconnected";
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
      return () => { listeners.delete(listener); };
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
