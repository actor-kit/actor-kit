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
 * Liveness (ADR-020): a socket can die without a close event (iOS froze the page). While open, the
 * client pings every `heartbeat.intervalMs`; a ping unanswered for `timeoutMs` (any frame answers)
 * abandons the socket and opens a new one at once. Visible/online ping at once. Sends while the
 * socket is not open wait for the next one. A frame that does not decode asks for the view again.
 *
 * Auth: getToken() is called on every (re)connect and sent via Sec-WebSocket-Protocol.
 * Native (RN/Node): getHeaders() can be passed as the third arg to WebSocket.
 *
 * Handles both binary frames and JSON fallback. Browser-safe: no CF deps.
 */

import type { FieldDescriptor, Infer, ParsedFrame, RefusalCode, SchemaDefinition } from "@actor-kit/core";
import {
  ActorKitError,
  applyDelta,
  decode,
  docsUrl,
  FrameType,
  isRefusalCode,
  parseFrame,
  xxh64,
} from "@actor-kit/core";
import { createLiveness, type HeartbeatOptions, NO_LIVENESS, resolveHeartbeat } from "./liveness";
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
  /** A message the actor refused (ADR-018 C), or a server error frame this client cannot read (`invalid_frame`). */
  onError?: ((error: ClientError) => void) | undefined;
  /** Liveness check of the open socket (ADR-020). Default `{ intervalMs: 20_000, timeoutMs: 5_000 }`; false turns it off. */
  heartbeat?: HeartbeatOptions | false | undefined;
}

/**
 * What `onError` receives: the refusal the actor sent for a message (`messageType`), with its code, a
 * message naming the fix, what it expected, details and a docs URL.
 */
export interface ClientError {
  readonly messageType: string;
  readonly code: RefusalCode | "invalid_frame";
  readonly message: string;
  readonly expected?: readonly string[];
  readonly details?: unknown;
  readonly docs: string;
}

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

/** A view frame that does not decode, also after asking again: the client bundle predates the Worker's schema. */
const UNDECODABLE_VIEW: ClientError = {
  messageType: "",
  code: "invalid_frame",
  message:
    "A view from the server does not decode with this client's view schema, also after asking again. Reload the page: the Worker was probably deployed with a newer schema.",
  docs: docsUrl("invalid_frame"),
};

function invalidFrame(messageType: string): ClientError {
  return {
    messageType,
    code: "invalid_frame",
    message:
      "The server sent an error frame this client cannot read. Use the same @actor-kit version on the client and the Worker.",
    docs: docsUrl("invalid_frame"),
  };
}

/** `expected` and `details`, each only when the frame has it. */
function optionalFields(expected: unknown, details: unknown): Pick<ClientError, "expected" | "details"> {
  const list = stringList(expected);
  return { ...(list === undefined ? {} : { expected: list }), ...(details === undefined ? {} : { details }) };
}

/** An __error frame as the ClientError it carries; one that does not parse is an `invalid_frame`. */
function clientError(frame: Record<string, unknown>): ClientError {
  const { code, message, docs } = frame;
  const messageType = stringOr(frame["messageType"], "");
  if (!isRefusalCode(code) || typeof message !== "string" || typeof docs !== "string") return invalidFrame(messageType);
  return { messageType, code, message, ...optionalFields(frame["expected"], frame["details"]), docs };
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
const PING = JSON.stringify({ type: "__ping" });
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
  // A `__reconnect` sent after a frame that did not decode, not yet answered by a frame that applied.
  let resyncPending = false;
  // onError was told that views do not decode; told again only after a frame applies.
  let undecodableReported = false;
  const heartbeat = resolveHeartbeat(options.heartbeat);
  const liveness =
    heartbeat === null ? NO_LIVENESS : createLiveness(heartbeat, { ping: () => sendRaw(PING), onDead: abandonSocket });

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
    resyncPending = false;
    undecodableReported = false;
  }

  /** Text on the socket if it is open; otherwise nothing (pings and resyncs are not queued). */
  function sendRaw(text: string) {
    if (ws?.readyState === WS_OPEN) ws.send(text);
  }

  /** A frame did not decode: ask for the view again, one request until a frame applies (ADR-020 D). */
  function requestResync() {
    if (resyncPending || lastChecksum === undefined) {
      reportUndecodable();
      return;
    }
    resyncPending = true;
    sendRaw(JSON.stringify({ type: "__reconnect", lastChecksum }));
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
      // Binary decode error: keep the last good view (and its checksum) and ask for the view again.
      requestResync();
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
        onError?.(clientError(msg));
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

  /** Views still do not decode (nothing to resync from, or the resync's answer did not either). */
  function reportUndecodable() {
    if (undecodableReported) return;
    undecodableReported = true;
    onError?.(UNDECODABLE_VIEW);
  }

  /** "online" / page visible: skip the rest of the backoff wait, or check that the open socket still answers. */
  function reconnectNow() {
    if (reconnectTimer === undefined) {
      liveness.probe();
      return;
    }
    clearReconnectTimer();
    void openSocket();
  }

  /** The open socket stopped answering: give up on it and open a new one now (ADR-020 A). */
  function abandonSocket() {
    const dead = ws;
    ws = undefined;
    setConnectionState("reconnecting");
    // openSocket() bumps the generation before its first await, so the dead socket's close event
    // is stale even when close() dispatches it at once (it would otherwise start a backoff retry).
    void openSocket();
    dead?.close();
  }

  function onClose() {
    liveness.stop();
    scheduleReconnect();
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
    resyncPending = false;
    liveness.start();
    if (lastChecksum !== undefined) {
      socket.send(JSON.stringify({ type: "__reconnect", lastChecksum }));
    }
    for (const queued of messageQueue.splice(0)) socket.send(JSON.stringify(queued));
  }

  function onMessage(data: unknown) {
    liveness.heard();
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
    opened.addEventListener("close", () => current() && onClose());
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
      throw new ActorKitError(
        "headers_in_browser",
        "getHeaders is not supported in browser environments — use getToken instead",
      );
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
      } else if (connectionState !== "disconnected") {
        // Connecting, reconnecting, or connected while the socket closes (before its close event).
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
      liveness.stop();
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
