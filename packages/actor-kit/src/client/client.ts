/**
 * Client SDK — connects to an actor via WebSocket and provides
 * subscribe/send/trigger API.
 *
 * Browser-safe: no CF deps.
 * Phase 1: JSON sync. Phase 2: binary sync.
 */

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
  WebSocketImpl?: typeof WebSocket;
  onRedirect?: ((target: { actorType: string; actorId: string }) => void) | undefined;
}

export function createActorClient(options: ClientOptions): ActorClient {
  const {
    actorType,
    actorId,
    host,
    accessToken,
    WebSocketImpl = WebSocket,
    onRedirect,
  } = options;

  let connectionState: ConnectionState = "connecting";
  let currentView: unknown = undefined;
  let currentRole: string | undefined = undefined;
  const listeners = new Set<(view: unknown) => void>();
  let ws: InstanceType<typeof WebSocketImpl> | undefined;

  // Connect
  const url = `wss://${host}/api/${actorType}/${actorId}`;
  ws = new WebSocketImpl(url, [`token.${accessToken}`]);

  ws.addEventListener("open", () => {
    // Still "connecting" until we receive first snapshot
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : "";
    try {
      const msg: unknown = JSON.parse(data);
      if (typeof msg !== "object" || msg === null) return;

      const msgObj = msg as Record<string, unknown>;

      if (msgObj["type"] === "snapshot") {
        currentView = msgObj["data"];
        currentRole = typeof msgObj["role"] === "string" ? msgObj["role"] : currentRole;
        connectionState = "connected";
        for (const listener of listeners) {
          listener(currentView);
        }
      } else if (msgObj["type"] === "__redirect") {
        const target = {
          actorType: typeof msgObj["actorType"] === "string" ? msgObj["actorType"] : actorType,
          actorId: typeof msgObj["actorId"] === "string" ? msgObj["actorId"] : actorId,
        };
        onRedirect?.(target);
      }
    } catch {
      // Invalid JSON — ignore
    }
  });

  ws.addEventListener("close", () => {
    if (connectionState !== "disconnected") {
      connectionState = "disconnected";
    }
  });

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
      connectionState = "disconnected";
      ws?.close();
    },
  };
}
