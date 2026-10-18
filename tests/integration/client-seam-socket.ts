/**
 * A WebSocketImpl for the real @actor-kit/client that connects to a real actor in workerd.
 *
 * The client builds `ws://localhost/api/<type>/<id>` and offers `auth.<token>`; this adapter does
 * what the app's Worker does (the token is the caller id here) and upgrades through the actor's
 * fetch(). It also plays the network: `drop()` loses the connection (both ends see a close),
 * `goZombie()` keeps the server end open while nothing gets through either way (a phone that
 * slept: iOS froze the socket and never told the page), `inject()` delivers a raw frame.
 */
import type { WebSocketConstructor, WebSocketLike } from "@actor-kit/client";

type Listener = (event: { readonly data?: unknown }) => void;
type EventName = "open" | "close" | "error" | "message";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class SeamSocket implements WebSocketLike {
  readyState = CONNECTING;
  binaryType?: string;
  /** Every message the client sent through this socket that reached the server. */
  readonly sent: string[] = [];
  private readonly listeners = new Map<EventName, Listener[]>();
  private server: WebSocket | null = null;
  private zombie = false;
  private closed = false;
  private corruptNext = false;

  constructor(upgrade: () => Promise<WebSocket>) {
    void upgrade().then(
      (ws) => this.attach(ws),
      () => this.finish(),
    );
  }

  addEventListener(type: EventName, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("send on a socket that is not open");
    if (this.zombie || this.server === null) return;
    this.sent.push(data);
    this.server.send(data);
  }

  close(): void {
    // A zombie's close frame never reaches the server either: its end stays open.
    if (!this.zombie) this.server?.close(1000);
    this.finish();
  }

  /** The network drops: the server sees the socket close and so does the client. */
  drop(): void {
    this.close();
  }

  /** Nothing gets through any more and nobody is told (half-open TCP after a suspended tab). */
  goZombie(): void {
    this.zombie = true;
  }

  /** Mark the socket closed the way a browser does before it dispatches the close event. */
  markClosedSilently(): void {
    this.readyState = CLOSED;
  }

  /** Dispatch the close event (after markClosedSilently), closing the server end. */
  dispatchClose(): void {
    this.close();
  }

  /** The next binary frame from the server arrives cut short (its header promises bytes that never come). */
  corruptNextFrame(): void {
    this.corruptNext = true;
  }

  /** Deliver a frame as if the server had sent it. */
  inject(data: ArrayBuffer | string): void {
    this.emit("message", { data });
  }

  private attach(ws: WebSocket): void {
    if (this.closed) {
      // The client gave up on this socket while it was upgrading: accept it only to close it.
      ws.accept();
      ws.close(1000);
      return;
    }
    this.server = ws;
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (this.zombie) return;
      const data = event.data;
      if (this.corruptNext && data instanceof ArrayBuffer) {
        this.corruptNext = false;
        this.emit("message", { data: data.slice(0, 6) });
        return;
      }
      this.emit("message", { data });
    });
    ws.addEventListener("close", () => {
      if (!this.zombie) this.finish();
    });
    this.readyState = OPEN;
    this.emit("open");
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = CLOSED;
    this.emit("close");
  }

  private emit(type: EventName, event: { readonly data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export interface SeamNetwork {
  readonly WebSocketImpl: WebSocketConstructor;
  /** Every socket the client opened, oldest first. */
  readonly sockets: SeamSocket[];
  /** The socket the client opened last. */
  latest(): SeamSocket;
}

/** A network to one actor: each socket the client opens upgrades through `stub.fetch()`. */
export function seamNetwork(stub: DurableObjectStub): SeamNetwork {
  const sockets: SeamSocket[] = [];
  const upgrade = async (url: string, protocols: readonly string[]): Promise<WebSocket> => {
    const caller = protocols.find((p) => p.startsWith("auth."))?.slice("auth.".length);
    if (caller === undefined) throw new Error("the client offered no auth.<token> protocol");
    const response = await stub.fetch(`http://localhost${new URL(url).pathname}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": protocols.join(", "),
        "X-Actor-Kit-Caller-Id": caller,
        "X-Actor-Kit-Caller-Type": "user",
        "X-Actor-Kit-Binary": "1",
      },
    });
    if (response.webSocket === null) throw new Error(`upgrade refused: ${response.status}`);
    return response.webSocket;
  };
  class Impl extends SeamSocket {
    constructor(url: string, protocols?: string | string[]) {
      const offered = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : protocols;
      super(() => upgrade(url, offered));
      sockets.push(this);
    }
  }
  return {
    WebSocketImpl: Impl,
    sockets,
    latest() {
      const last = sockets.at(-1);
      if (last === undefined) throw new Error("the client has not opened a socket");
      return last;
    },
  };
}

/** Polls `check` until it stops throwing, or rethrows its last error after `timeoutMs`. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** A page's `document` for the client's visibility listener (workerd has none). */
export function fakeDocument() {
  const target = new EventTarget();
  let visibilityState: "visible" | "hidden" = "visible";
  const doc = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return {
    doc,
    hide() {
      visibilityState = "hidden";
      target.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      visibilityState = "visible";
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
}
