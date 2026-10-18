// @vitest-environment jsdom
/**
 * Reconnection resilience (the two reconnect bugs fixed in actor-kit v1 0.52.7):
 *  (a) a reconnect reports the checksum of the last view the client applied, never the page-load one;
 *  (b) reconnection never gives up: backoff doubles up to a 30 s cap and retries forever, the browser's
 *      "online" and "visibilitychange → visible" events reconnect at once, close events from superseded
 *      sockets are ignored, and disconnect() cancels every pending retry and listener.
 */

import { createActorClient } from "@actor-kit/client";
import { createDeltaFrame, createSnapshotFrame, encode, encodeDelta, schema, uint32, xxh64 } from "@actor-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { data?: unknown }) => void;

/** A socket the test drives by hand: nothing opens or closes unless the test says so. */
class ManualSocket {
  static created: ManualSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sent: string[] = [];
  readyState = 0;
  binaryType = "blob";
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    ManualSocket.created.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Like a browser: close() only starts the closing handshake; the close event comes later. */
  close(): void {
    this.closeCalls++;
    this.readyState = 2;
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  serverOpens(): void {
    this.readyState = 1;
    this.emit("open");
  }

  serverCloses(): void {
    this.readyState = 3;
    this.emit("close");
  }

  receive(data: string | ArrayBuffer): void {
    this.emit("message", { data });
  }

  reconnectMessages(): Array<{ type: string; lastChecksum?: unknown }> {
    return this.sent
      .map((raw): unknown => JSON.parse(raw))
      .filter((m): m is { type: string; lastChecksum?: unknown } => {
        return typeof m === "object" && m !== null && "type" in m && m.type === "__reconnect";
      });
  }
}

function socketAt(index: number): ManualSocket {
  const socket = ManualSocket.created[index];
  if (!socket) throw new Error(`no socket #${index}; ${ManualSocket.created.length} created`);
  return socket;
}

function latestSocket(): ManualSocket {
  return socketAt(ManualSocket.created.length - 1);
}

const Counter = schema({ count: uint32 });

/** Every client a test creates; afterEach disconnects them so no window listener leaks into the next test. */
const clients: Array<{ disconnect(): void }> = [];

function track<T extends { disconnect(): void }>(client: T): T {
  clients.push(client);
  return client;
}

function makeClient(
  overrides: { getToken?: () => string | Promise<string>; initialView?: unknown; heartbeat?: false } = {},
) {
  return track(
    createActorClient({
      path: "/api/counter/c1",
      host: "example.com",
      initialView: overrides.initialView,
      getToken: overrides.getToken ?? (() => "token"),
      WebSocketImpl: ManualSocket,
      ...(overrides.heartbeat === undefined ? {} : { heartbeat: overrides.heartbeat }),
    }),
  );
}

/** Let the async openSocket() (await getToken) construct its socket. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

beforeEach(() => {
  ManualSocket.created = [];
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});

describe("reconnect backoff (bug b: never give up)", () => {
  it("keeps retrying after many failed attempts instead of going disconnected", async () => {
    const client = makeClient();
    client.connect();
    await settle();

    for (let attempt = 0; attempt < 25; attempt++) {
      latestSocket().serverCloses();
      expect(client.connectionState).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(ManualSocket.created).toHaveLength(26);
    expect(client.connectionState).toBe("reconnecting");
  });

  it("doubles the delay from 1 s and caps it at 30 s", async () => {
    const client = makeClient();
    client.connect();
    await settle();

    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (const delay of expectedDelays) {
      const before = ManualSocket.created.length;
      latestSocket().serverCloses();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(ManualSocket.created).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(ManualSocket.created).toHaveLength(before + 1);
    }
    expect(client.connectionState).toBe("reconnecting");
  });

  it("starts the backoff over at 1 s after a socket opens", async () => {
    const client = makeClient();
    client.connect();
    await settle();

    latestSocket().serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().serverCloses();
    await vi.advanceTimersByTimeAsync(2000);
    latestSocket().serverOpens();
    latestSocket().serverCloses();

    const before = ManualSocket.created.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ManualSocket.created).toHaveLength(before + 1);
    expect(client.connectionState).toBe("reconnecting");
  });
});

describe("reconnect triggers (bug b: online / visibility)", () => {
  it("reconnects immediately when the browser comes back online", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    for (let i = 0; i < 6; i++) {
      latestSocket().serverCloses();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    latestSocket().serverCloses();
    const before = ManualSocket.created.length;

    window.dispatchEvent(new Event("online"));
    await settle();

    expect(ManualSocket.created).toHaveLength(before + 1);
    expect(client.connectionState).toBe("reconnecting");
  });

  it("does not also open the socket the cancelled backoff timer would have opened", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    latestSocket().serverCloses();

    window.dispatchEvent(new Event("online"));
    await settle();
    const after = ManualSocket.created.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ManualSocket.created).toHaveLength(after);
    expect(client.connectionState).toBe("reconnecting");
  });

  it("reconnects immediately when the page becomes visible again", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    latestSocket().serverCloses();
    const before = ManualSocket.created.length;

    setVisibility("visible");
    await settle();

    expect(ManualSocket.created).toHaveLength(before + 1);
    expect(client.connectionState).toBe("reconnecting");
  });

  it("does nothing when the page becomes hidden", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    latestSocket().serverCloses();
    const before = ManualSocket.created.length;

    setVisibility("hidden");
    await settle();

    expect(ManualSocket.created).toHaveLength(before);
  });

  it("does not open a second socket on online/visible while the current one is healthy", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    latestSocket().serverOpens();
    latestSocket().receive(JSON.stringify({ type: "snapshot", data: { count: 1 } }));

    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    await settle();

    expect(ManualSocket.created).toHaveLength(1);
    expect(client.connectionState).toBe("connected");
  });

  it("ignores online/visible before connect() and after disconnect()", async () => {
    const client = makeClient();
    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    await settle();
    expect(ManualSocket.created).toHaveLength(0);

    client.connect();
    await settle();
    latestSocket().serverCloses();
    client.disconnect();
    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    await settle();

    expect(ManualSocket.created).toHaveLength(1);
    expect(client.connectionState).toBe("disconnected");
  });
});

describe("superseded sockets and disconnect (bug b)", () => {
  it("ignores a late close event from the socket a disconnect() replaced", async () => {
    // The fake server stays silent for 60 s below; with the heartbeat (ADR-020) that socket would be
    // replaced as dead, which is not what this test is about (approved by Jon, 2026-10-18).
    const client = makeClient({ heartbeat: false });
    client.connect();
    await settle();
    const first = latestSocket();
    first.serverOpens();

    client.disconnect();
    client.connect();
    await settle();
    const second = latestSocket();
    second.serverOpens();
    second.receive(JSON.stringify({ type: "snapshot", data: { count: 1 } }));

    first.serverCloses(); // the old socket's close handshake finishes now
    await vi.advanceTimersByTimeAsync(60_000);

    expect(first.closeCalls).toBe(1);
    expect(ManualSocket.created).toHaveLength(2);
    expect(client.connectionState).toBe("connected");
  });

  it("ignores messages from a superseded socket", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    const first = latestSocket();
    first.serverOpens();
    client.disconnect();
    client.connect();
    await settle();
    latestSocket().serverOpens();
    latestSocket().receive(JSON.stringify({ type: "snapshot", data: { count: 2 } }));

    first.receive(JSON.stringify({ type: "snapshot", data: { count: 99 } }));

    expect(client.view).toEqual({ count: 2 });
  });

  it("cancels the pending retry on disconnect()", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    latestSocket().serverCloses();
    expect(client.connectionState).toBe("reconnecting");

    client.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(ManualSocket.created).toHaveLength(1);
    expect(client.connectionState).toBe("disconnected");
  });

  it("does not open a socket when disconnect() lands while the token is still being fetched", async () => {
    let releaseToken: (token: string) => void = () => {};
    const client = makeClient({
      getToken: () =>
        new Promise<string>((resolve) => {
          releaseToken = resolve;
        }),
    });
    client.connect();
    client.disconnect();
    releaseToken("token");
    await settle();

    expect(ManualSocket.created).toHaveLength(0);
    expect(client.connectionState).toBe("disconnected");
  });

  it("opens exactly one socket when connect() runs during a reconnect wait", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    latestSocket().serverCloses();
    expect(client.connectionState).toBe("reconnecting");

    client.connect();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    // connect() during "reconnecting" opens one socket now; the backoff timer must not open another.
    expect(ManualSocket.created).toHaveLength(2);
  });
});

describe("token and header failures", () => {
  it("retries with backoff when getToken() rejects, instead of stalling", async () => {
    let calls = 0;
    const client = makeClient({
      getToken: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error("token service down")) : Promise.resolve("token");
      },
    });
    client.connect();
    await settle();
    expect(ManualSocket.created).toHaveLength(0);
    expect(client.connectionState).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toBe(2);
    expect(ManualSocket.created).toHaveLength(1);
  });

  it("throws from connect() when getHeaders is used in a browser", () => {
    const client = createActorClient({
      path: "/api/counter/c1",
      host: "example.com",
      initialView: undefined,
      getHeaders: () => ({ authorization: "x" }),
      WebSocketImpl: ManualSocket,
    });

    expect(() => client.connect()).toThrow("getHeaders is not supported in browser environments");
    expect(client.connectionState).toBe("disconnected");
    expect(ManualSocket.created).toHaveLength(0);
  });
});

describe("reconnect checksum (bug a: last applied view, not page load)", () => {
  it("sends the checksum of the view after the last applied delta", async () => {
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchema: Counter,
        getToken: () => "token",
        WebSocketImpl: ManualSocket,
      }),
    );
    client.connect();
    await settle();
    const socket = latestSocket();
    socket.serverOpens();
    socket.receive(toArrayBuffer(createSnapshotFrame(1, 0, encode(Counter, { count: 1 }))));
    const delta = encodeDelta(Counter, { count: 1 }, { count: 7 });
    if (!delta) throw new Error("expected a delta");
    socket.receive(toArrayBuffer(createDeltaFrame(1, delta)));
    expect(client.view).toEqual({ count: 7 });

    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().serverOpens();

    expect(latestSocket().reconnectMessages()).toEqual([
      { type: "__reconnect", lastChecksum: xxh64(JSON.stringify({ count: 7 })) },
    ]);
  });

  it("drops a binary checksum once a JSON snapshot replaces that view (no stale checksum)", async () => {
    // Per-role schemas: the caller's role changes to one without a schema, so the server switches to JSON.
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchema: Counter,
        getToken: () => "token",
        WebSocketImpl: ManualSocket,
      }),
    );
    client.connect();
    await settle();
    latestSocket().serverOpens();
    latestSocket().receive(toArrayBuffer(createSnapshotFrame(1, 0, encode(Counter, { count: 1 }))));
    latestSocket().receive(JSON.stringify({ type: "snapshot", role: "viewer", data: { count: 4 } }));
    expect(client.view).toEqual({ count: 4 });

    latestSocket().serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().serverOpens();

    // JSON mode sends no __reconnect (the server sends a fresh snapshot on every connect anyway),
    // and the checksum of the replaced binary view must not be sent either.
    expect(latestSocket().reconnectMessages()).toEqual([]);
  });

  it("never reports the page-load (SSR) view's checksum when nothing was applied yet", async () => {
    const client = makeClient({ initialView: { count: 5 } });
    client.connect();
    await settle();
    latestSocket().serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().serverOpens();

    expect(latestSocket().reconnectMessages()).toEqual([]);
  });

  it("keeps the last good checksum when a delta fails to apply", async () => {
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchema: Counter,
        getToken: () => "token",
        WebSocketImpl: ManualSocket,
      }),
    );
    client.connect();
    await settle();
    const socket = latestSocket();
    socket.serverOpens();
    socket.receive(toArrayBuffer(createSnapshotFrame(1, 0, encode(Counter, { count: 2 }))));
    socket.receive(toArrayBuffer(createDeltaFrame(1, new Uint8Array([0xff])))); // truncated: bit set, no value
    expect(client.view).toEqual({ count: 2 });

    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latestSocket().serverOpens();

    expect(latestSocket().reconnectMessages()).toEqual([
      { type: "__reconnect", lastChecksum: xxh64(JSON.stringify({ count: 2 })) },
    ]);
  });
});
