/**
 * Client SDK — connects to an actor via WebSocket and provides
 * subscribe/send/trigger API with automatic reconnection.
 *
 * Two-phase lifecycle:
 *   1. createActorClient(options) — builds the client object, sets initialView,
 *      DOES NOT open the WebSocket. Safe in React Strict Mode.
 *   2. client.connect() — opens the WebSocket. Idempotent if already connected.
 *
 * Reconnection: an unexpected close retries forever with exponential backoff (1 s doubling, capped at
 * 30 s). The browser's "online" event and the page becoming visible retry at once. Every socket is tagged
 * with a generation; events from a socket that a newer connect/disconnect superseded are ignored.
 * On reopen the client sends `__reconnect` with the checksum of the last view it applied.
 *
 * Auth: getToken() is called on every (re)connect and sent via Sec-WebSocket-Protocol.
 * Native (RN/Node): getHeaders() can be passed as the third arg to WebSocket.
 *
 * Handles both binary frames and JSON fallback. Browser-safe: no CF deps.
 */

import type { FieldDescriptor, Infer, ParsedFrame, SchemaDefinition } from "@actor-kit/core";
import { applyDelta, decode, FrameType, parseFrame, xxh64 } from "@actor-kit/core";
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
  /** WebSocket constructor. Defaults to the global WebSocket; RN/Node implementations also accept { headers }. */
  WebSocketImpl?: WebSocketConstructor | undefined;
  onRedirect?: ((target: { actorType: string; actorId: string }) => void) | undefined;
  onError?: ((error: { message: string; error: string }) => void) | undefined;
}

/** The part of a WebSocket the client uses. The DOM WebSocket satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
}

/** A WebSocket constructor; the third argument carries upgrade headers on React Native and Node. */
export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

const WS_OPEN = 1;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Backoff before retry number `attempt` (0-based): 1 s, 2 s, 4 s … capped at 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
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
  const { path, host, initialView, getToken, getHeaders, viewSchema, viewSchemas, roleNames, onRedirect, onError } =
    options;
  const WebSocketImpl: WebSocketConstructor = options.WebSocketImpl ?? WebSocket;

  let connectionState: ConnectionState = "disconnected";
  let currentView: unknown = initialView;
  // Seed from initialView's role discriminant so role-branching UIs render the
  // correct branch during SSR / before the first frame arrives.
  let currentRole: string | undefined = roleFromView(initialView);
  const listeners = new Set<(view: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let ws: WebSocketLike | undefined;
  // Bumped by every open and by disconnect(); a socket (or a pending open) whose generation is older is stale.
  let generation = 0;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Checksum of the last binary view applied in this connect() session; never the page-load (SSR) view.
  // A reopen reports it in `__reconnect`; disconnect() and JSON snapshots clear it.
  let lastChecksum: string | undefined;
  let activeSchema: SchemaDefinition<Record<string, FieldDescriptor>> | undefined = viewSchema;
  const messageQueue: Array<{ type: string; [key: string]: unknown }> = [];

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

  /** A view decoded from a binary frame; its checksum is what a reconnect reports. */
  function applyView(view: unknown) {
    currentView = view;
    lastChecksum = xxh64(JSON.stringify(view));
  }

  function resolveSchema(roleIndex: number | undefined): SchemaDefinition<Record<string, FieldDescriptor>> | undefined {
    const roleName = roleIndex === undefined ? undefined : roleNames?.[roleIndex];
    return (roleName === undefined ? undefined : viewSchemas?.[roleName]) ?? viewSchema;
  }

  function handleSnapshotFrame(frame: ParsedFrame) {
    const resolved = resolveSchema(frame.roleIndex);
    if (!resolved) return;
    activeSchema = resolved;
    applyView(decode(resolved, frame.payload));
    const roleName = frame.roleIndex === undefined ? undefined : roleNames?.[frame.roleIndex];
    if (roleName !== undefined) currentRole = roleName;
    setConnectionState("connected");
    notifyListeners();
  }

  function handleDeltaFrame(frame: ParsedFrame) {
    if (!activeSchema || !isRecord(currentView)) return;
    applyView(applyDelta(activeSchema, currentView, frame.payload));
    notifyListeners();
  }

  function handleControlFrame(frame: ParsedFrame) {
    const ctrl = parseJson(new TextDecoder().decode(frame.payload));
    if (isRecord(ctrl) && ("actorType" in ctrl || "actorId" in ctrl)) {
      onRedirect?.(redirectTarget(ctrl));
    }
  }

  function handleBinaryMessage(data: ArrayBuffer) {
    try {
      const frame = parseFrame(new Uint8Array(data));
      if (frame.type === FrameType.SNAPSHOT) handleSnapshotFrame(frame);
      else if (frame.type === FrameType.DELTA) handleDeltaFrame(frame);
      else handleControlFrame(frame);
    } catch {
      // Binary decode error: keep the last good view (and its checksum).
    }
  }

  function handleJsonMessage(data: string) {
    const msg = parseJson(data);
    if (!isRecord(msg)) return;
    switch (msg["type"]) {
      case "snapshot":
        // JSON mode never reports a checksum on reconnect; forget the one of the view this replaces.
        currentView = msg["data"];
        lastChecksum = undefined;
        currentRole = typeof msg["role"] === "string" ? msg["role"] : currentRole;
        setConnectionState("connected");
        notifyListeners();
        return;
      case "__redirect":
        onRedirect?.(redirectTarget(msg));
        return;
      case "__reconnect_ack":
        setConnectionState("connected");
        return;
      case "__error":
        onError?.({
          message: stringOr(msg["message"], ""),
          error: stringOr(msg["error"], stringOr(msg["detail"], "unknown")),
        });
        return;
    }
  }

  function clearReconnectTimer() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function scheduleReconnect() {
    setConnectionState("reconnecting");
    const delay = reconnectDelay(reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void openSocket();
    }, delay);
  }

  /** "online" / page visible: skip the rest of the backoff wait. */
  function reconnectNow() {
    if (reconnectTimer === undefined) return;
    clearReconnectTimer();
    void openSocket();
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") reconnectNow();
  }

  function attachBrowserListeners() {
    if (typeof window !== "undefined") window.addEventListener("online", reconnectNow);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function detachBrowserListeners() {
    if (typeof window !== "undefined") window.removeEventListener("online", reconnectNow);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function onOpen(socket: WebSocketLike) {
    reconnectAttempts = 0;
    if (lastChecksum !== undefined) {
      socket.send(JSON.stringify({ type: "__reconnect", lastChecksum }));
    }
    for (const queued of messageQueue.splice(0)) socket.send(JSON.stringify(queued));
  }

  function onMessage(data: unknown) {
    if (data instanceof ArrayBuffer) handleBinaryMessage(data);
    else if (typeof data === "string") handleJsonMessage(data);
  }

  async function openSocket() {
    const mine = ++generation;
    const current = () => mine === generation;
    let socket: WebSocketLike | undefined;
    try {
      socket = await createSocket(current);
    } catch {
      // Token or header fetch failed: retry with backoff like a dropped connection.
      if (current()) scheduleReconnect();
      return;
    }
    // undefined: disconnect() or a newer open happened while the token was being fetched.
    if (!socket) return;
    const opened = socket;
    ws = opened;
    opened.binaryType = "arraybuffer";
    opened.addEventListener("open", () => current() && onOpen(opened));
    opened.addEventListener("message", (event) => current() && onMessage(event.data));
    opened.addEventListener("close", () => current() && scheduleReconnect());
    // "error" is always followed by "close", which handles reconnection.
  }

  /** Builds the socket, or returns undefined if `stillCurrent()` turns false while awaiting credentials. */
  async function createSocket(stillCurrent: () => boolean): Promise<WebSocketLike | undefined> {
    const url = buildUrl(path, host);
    // Always include the actor-kit version marker.
    const protocols: string[] = ["actor-kit.v1"];
    if (getToken) protocols.push(`auth.${await getToken()}`);
    // Native only: optional headers as the third constructor argument.
    const headers = getHeaders ? await getHeaders() : undefined;
    if (!stillCurrent()) return undefined;
    return headers ? new WebSocketImpl(url, protocols, { headers }) : new WebSocketImpl(url, protocols);
  }

  function connect() {
    if (connectionState === "connecting" || connectionState === "connected") return;
    // getHeaders is native-only: fail loudly in browsers.
    if (getHeaders && isBrowserEnv()) {
      throw new Error("getHeaders is not supported in browser environments — use getToken instead");
    }
    clearReconnectTimer();
    if (connectionState === "disconnected") {
      setConnectionState("connecting");
      attachBrowserListeners();
    }
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
      if (ws && ws.readyState === WS_OPEN) {
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
      setConnectionState("disconnected");
      messageQueue.length = 0;
      clearReconnectTimer();
      detachBrowserListeners();
      reconnectAttempts = 0;
      lastChecksum = undefined;
      // Bumping the generation makes the closing socket's late events (and any pending open) stale.
      generation++;
      ws?.close();
      ws = undefined;
    },
  };
}

function isBrowserEnv(): boolean {
  return typeof window !== "undefined" && "WebSocket" in window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function redirectTarget(source: Record<string, unknown>): { actorType: string; actorId: string } {
  return { actorType: stringOr(source["actorType"], ""), actorId: stringOr(source["actorId"], "") };
}

function roleFromView(view: unknown): string | undefined {
  if (typeof view !== "object" || view === null || !("role" in view)) return undefined;
  return typeof view.role === "string" ? view.role : undefined;
}
