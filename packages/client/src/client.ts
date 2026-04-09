/**
 * Client SDK — connects to an actor via WebSocket and provides
 * subscribe/send/trigger API with automatic reconnection.
 *
 * Two-phase lifecycle:
 *   1. createActorClient(options) — builds the client object, sets initialView,
 *      DOES NOT open the WebSocket. Safe in React Strict Mode.
 *   2. client.connect() — opens the WebSocket. Idempotent if already connected.
 *
 * Auth: getToken() is called on every (re)connect and sent via Sec-WebSocket-Protocol.
 * Native (RN/Node): getHeaders() can be passed as the third arg to WebSocket.
 *
 * Handles both binary frames and JSON fallback. Browser-safe: no CF deps.
 */

import type { FieldDescriptor, Infer, SchemaDefinition } from "@actor-kit/core";
import { applyDelta, decode, FrameType, parseFrame } from "@actor-kit/core";
import { buildUrl } from "./url";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface ActorClient<
  TView = unknown,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
> {
  readonly connectionState: ConnectionState;
  readonly view: TView;
  readonly role: string | undefined;
  subscribe(listener: (view: TView) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  send(event: TEvent): void;
  trigger(type: string, payload?: Record<string, unknown>): void;
  connect(): void;
  disconnect(): void;
}

interface ClientOptions<TView = unknown> {
  /** Path on the server (required), e.g. "/api/counter/test-1" */
  path: string;
  /** Host with optional port. Defaults to window.location.host in the browser. */
  host?: string | undefined;
  /** Initial view from the server (SSR snapshot). Required. */
  initialView: TView;
  /** Token getter — sent via Sec-WebSocket-Protocol on every (re)connect. */
  getToken?: (() => string | Promise<string>) | undefined;
  /** Headers getter — sent on the WebSocket upgrade (native only; throws in browser). */
  getHeaders?: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  /** Schema for decoding binary frames. If not provided, falls back to JSON. */
  viewSchema?: SchemaDefinition<Record<string, FieldDescriptor>> | undefined;
  /** Per-role schemas for binary decoding (contract-derived). Takes precedence over viewSchema. */
  viewSchemas?: Record<string, SchemaDefinition<Record<string, FieldDescriptor>>> | undefined;
  /** Role names in definition order (for mapping roleIndex to role name). Internal. */
  roleNames?: string[] | undefined;
  WebSocketImpl?: typeof WebSocket;
  onRedirect?: ((target: { actorType: string; actorId: string }) => void) | undefined;
  onError?: ((error: { message: string; error: string }) => void) | undefined;
  maxReconnectAttempts?: number | undefined;
}

export type { ClientOptions };

// Overload: with viewSchema → view type inferred from schema, TEvent explicit
export function createActorClient<
  TShape extends Record<string, FieldDescriptor>,
  TEvent extends { type: string } = { type: string; [key: string]: unknown },
>(
  options: ClientOptions<Infer<SchemaDefinition<TShape>>> & {
    viewSchema: SchemaDefinition<TShape>;
  },
): ActorClient<Infer<SchemaDefinition<TShape>>, TEvent>;

// Overload: explicit TView via ClientOptions<TView>
export function createActorClient<TView, TEvent extends { type: string } = { type: string; [key: string]: unknown }>(
  options: ClientOptions<TView>,
): ActorClient<TView, TEvent>;

// Implementation
export function createActorClient(options: ClientOptions<unknown>): ActorClient<unknown> {
  const {
    path,
    host,
    initialView,
    getToken,
    getHeaders,
    viewSchema,
    viewSchemas,
    roleNames,
    WebSocketImpl = WebSocket,
    onRedirect,
    onError,
    maxReconnectAttempts = 10,
  } = options;

  let connectionState: ConnectionState = "disconnected";
  let currentView: unknown = initialView;
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
        lastChecksum = computeChecksum(JSON.stringify(currentView));
        setConnectionState("connected");
        notifyListeners();
      } else if (frame.type === FrameType.DELTA) {
        if (activeSchema && currentView) {
          currentView = applyDelta(activeSchema, currentView as Record<string, unknown>, frame.payload);
          lastChecksum = computeChecksum(JSON.stringify(currentView));
          notifyListeners();
        }
      } else if (frame.type === FrameType.CONTROL && frame.controlType !== undefined) {
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

  function isBrowserEnv(): boolean {
    return typeof window !== "undefined" && typeof (window as { WebSocket?: unknown }).WebSocket !== "undefined";
  }

  async function openSocket() {
    const url = buildUrl(path, host);

    // getHeaders is native-only — fail loudly in browsers.
    if (getHeaders && isBrowserEnv()) {
      throw new Error("getHeaders is not supported in browser environments — use getToken instead");
    }

    // Build subprotocols. Always include the actor-kit version marker.
    const protocols: string[] = ["actor-kit.v1"];
    if (getToken) {
      const token = await getToken();
      protocols.push(`auth.${token}`);
    }

    // Native only: optional headers as 3rd ctor arg.
    let headers: Record<string, string> | undefined;
    if (getHeaders && !isBrowserEnv()) {
      headers = await getHeaders();
    }

    // Construct the WebSocket. RN/Node allow an optional 3rd-arg options bag with `headers`.
    interface ExtendedWebSocketCtor {
      new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }): WebSocket;
    }
    const Ctor: ExtendedWebSocketCtor = WebSocketImpl;
    ws = headers ? new Ctor(url, protocols, { headers }) : new Ctor(url, protocols);

    if ("binaryType" in ws) {
      (ws as { binaryType: string }).binaryType = "arraybuffer";
    }

    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      if (isReconnecting && lastChecksum) {
        ws?.send(JSON.stringify({ type: "__reconnect", lastChecksum }));
        isReconnecting = false;
      }
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
          void openSocket();
        }, delay);
      } else {
        setConnectionState("disconnected");
      }
    });

    ws.addEventListener("error", () => {
      // Error triggers close, which handles reconnection
    });
  }

  function connect() {
    if (connectionState === "connecting" || connectionState === "connected") return;
    intentionalClose = false;
    setConnectionState("connecting");
    void openSocket();
  }

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
    connect,
    disconnect() {
      intentionalClose = true;
      setConnectionState("disconnected");
      messageQueue.length = 0;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      ws?.close();
      ws = undefined;
    },
  };
}
