// @vitest-environment jsdom
/**
 * ADR-020 in the client: the heartbeat that finds a silent socket, the probe on visible/online, the
 * queue for sends in the closing window, and the resync after a frame that does not decode.
 * Seam: a hand-driven fake socket and fake timers; nothing inside the client is mocked.
 */
import { actorClient, createActorClient } from "@actor-kit/client";
import { createDeltaFrame, createSnapshotFrame, encode, encodeDelta, schema, uint32, xxh64 } from "@actor-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { data?: unknown }) => void;

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

  send(data: string): void {
    this.sent.push(data);
  }

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

  receive(data: unknown): void {
    this.emit("message", { data });
  }

  receiveFrame(bytes: Uint8Array): void {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.receive(copy);
  }

  types(): string[] {
    return this.sent.map((raw) => {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && "type" in parsed ? String(parsed.type) : "?";
    });
  }

  parsed(): unknown[] {
    return this.sent.map((raw): unknown => JSON.parse(raw));
  }
}

function latest(): ManualSocket {
  const socket = ManualSocket.created.at(-1);
  if (socket === undefined) throw new Error("no socket");
  return socket;
}

const Counter = schema({ count: uint32 });
const clients: Array<{ disconnect(): void }> = [];

type Heartbeat = { intervalMs?: number; timeoutMs?: number } | false | "default";

function makeClient(heartbeat: Heartbeat = { intervalMs: 1000, timeoutMs: 300 }) {
  const client = createActorClient({
    path: "/api/counter/c1",
    host: "example.com",
    initialView: { count: 0 },
    viewSchema: Counter,
    getToken: () => "token",
    WebSocketImpl: ManualSocket,
    ...(heartbeat === "default" ? {} : { heartbeat }),
  });
  clients.push(client);
  return client;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** connect(), the socket opens, the first snapshot arrives. */
async function connected(heartbeat: Heartbeat = { intervalMs: 1000, timeoutMs: 300 }) {
  const client = makeClient(heartbeat);
  client.connect();
  await settle();
  const socket = latest();
  socket.serverOpens();
  socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 1 })));
  return { client, socket };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const pong = JSON.stringify({ type: "__pong" });

beforeEach(() => {
  ManualSocket.created = [];
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});

describe("heartbeat (ADR-020 A)", () => {
  it("sends __ping every intervalMs once the socket is open, and nothing before", async () => {
    const client = makeClient();
    client.connect();
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(latest().sent).toEqual([]);

    latest().serverOpens();
    await vi.advanceTimersByTimeAsync(1000);
    expect(latest().sent).toEqual([JSON.stringify({ type: "__ping" })]);
    latest().receive(pong);
    await vi.advanceTimersByTimeAsync(1000);
    expect(latest().types()).toEqual(["__ping", "__ping"]);
  });

  it("pings every 20 s with 5 s to answer by default", async () => {
    const { socket } = await connected("default");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(socket.types()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.types()).toEqual(["__ping"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ManualSocket.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ManualSocket.created).toHaveLength(2);
  });

  it("a socket that does not answer is closed and replaced at once, without the backoff wait", async () => {
    const { client, socket } = await connected();
    const states: string[] = [];
    client.onStateChange((state) => states.push(state));

    await vi.advanceTimersByTimeAsync(1000 + 300);

    expect(socket.closeCalls).toBe(1);
    expect(ManualSocket.created).toHaveLength(2);
    expect(states).toEqual(["reconnecting"]);
    const next = latest();
    next.serverOpens();
    expect(next.parsed()).toEqual([{ type: "__reconnect", lastChecksum: xxh64(JSON.stringify({ count: 1 })) }]);
    next.receive(JSON.stringify({ type: "__reconnect_ack" }));
    expect(states).toEqual(["reconnecting", "connected"]);
  });

  it("ignores everything the abandoned socket does afterwards", async () => {
    const { client, socket } = await connected();
    await vi.advanceTimersByTimeAsync(1300);
    const next = latest();
    next.serverOpens();
    next.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 5 })));

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 2 })));
    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(500);

    expect(client.view).toEqual({ count: 5 });
    expect(client.connectionState).toBe("connected");
    expect(ManualSocket.created).toHaveLength(2);
  });

  it("any frame counts as an answer, not only __pong", async () => {
    const { client, socket } = await connected();
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 2; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(299);
      socket.receiveFrame(createDeltaFrame(1, deltaTo(i))); // 299 ms after this interval's ping
      await vi.advanceTimersByTimeAsync(701);
    }
    expect(ManualSocket.created).toHaveLength(1);
    expect(client.view).toEqual({ count: 7 });
  });

  it("stops pinging a socket once it closed, and after disconnect()", async () => {
    const { client, socket } = await connected();
    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    const next = latest();
    next.serverOpens();
    client.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(next.types()).toEqual(["__reconnect"]);
    expect(ManualSocket.created).toHaveLength(2);
  });

  it("false: no pings, and visible/online on a connected client do nothing", async () => {
    const { socket } = await connected(false);
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility("visible");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.sent).toEqual([]);
    expect(ManualSocket.created).toHaveLength(1);
  });

  it("actorClient(...).create() passes heartbeat through", async () => {
    const client = actorClient(Counter).create({
      path: "/api/counter/c1",
      host: "example.com",
      initialView: { count: 0 },
      getToken: () => "token",
      WebSocketImpl: ManualSocket,
      heartbeat: false,
    });
    clients.push(client);
    client.connect();
    await settle();
    latest().serverOpens();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(latest().sent).toEqual([]);
  });
});

/** A delta frame payload from count n - 1 to n. */
function deltaTo(n: number): Uint8Array {
  const delta = encodeDelta(Counter, { count: n - 1 }, { count: n });
  if (delta === null) throw new Error("expected a delta");
  return delta;
}

describe("probe on visible / online (ADR-020 A)", () => {
  it("the page becoming visible pings at once; no answer replaces the socket", async () => {
    const { socket } = await connected();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.sent).toEqual([]);

    setVisibility("visible");
    expect(socket.types()).toEqual(["__ping"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(ManualSocket.created).toHaveLength(2);
  });

  it("an answer to the probe keeps the socket", async () => {
    const { client, socket } = await connected();
    setVisibility("visible");
    socket.receive(pong);
    await vi.advanceTimersByTimeAsync(400);
    expect(ManualSocket.created).toHaveLength(1);
    expect(client.connectionState).toBe("connected");
  });

  it("the browser coming back online pings at once", async () => {
    const { socket } = await connected();
    window.dispatchEvent(new Event("online"));
    expect(socket.types()).toEqual(["__ping"]);
  });

  it("while a reconnect waits, visible still skips the wait (no ping on a closed socket)", async () => {
    const { socket } = await connected();
    socket.serverCloses();
    setVisibility("visible");
    await settle();
    expect(socket.sent).toEqual([]);
    expect(ManualSocket.created).toHaveLength(2);
  });
});

describe("sends in the closing window (ADR-020 C)", () => {
  it("a send after the socket stopped being open, before its close event, goes out on the next socket", async () => {
    const { client, socket } = await connected();
    socket.readyState = 2;
    client.send({ type: "TAP" });
    expect(socket.sent).toEqual([]);

    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    latest().serverOpens();
    expect(latest().types()).toEqual(["__reconnect", "TAP"]);
  });

  it("a send after the heartbeat abandoned the socket goes out on the next one", async () => {
    const { client } = await connected();
    await vi.advanceTimersByTimeAsync(1300);
    client.send({ type: "TAP" });
    latest().serverOpens();
    expect(latest().types()).toEqual(["__reconnect", "TAP"]);
  });
});

describe("resync after a frame that does not decode (ADR-020 D)", () => {
  const checksumOf = (view: unknown) => xxh64(JSON.stringify(view));

  it("asks the actor for the view again with the last good checksum", async () => {
    const { client, socket } = await connected(false);
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([0xff])));

    expect(client.view).toEqual({ count: 1 });
    expect(socket.parsed()).toEqual([{ type: "__reconnect", lastChecksum: checksumOf({ count: 1 }) }]);
  });

  it("one request at a time: another only after a frame has applied", async () => {
    const { socket } = await connected(false);
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([0xff])));
    socket.receiveFrame(new Uint8Array([1, 1, 0, 0, 0, 9]));
    expect(socket.types()).toEqual(["__reconnect"]);

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 4 })));
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([0xff])));
    expect(socket.parsed()).toEqual([
      { type: "__reconnect", lastChecksum: checksumOf({ count: 1 }) },
      { type: "__reconnect", lastChecksum: checksumOf({ count: 4 }) },
    ]);
  });

  it("a new socket may ask again (the request on the old one was lost with it)", async () => {
    const { socket } = await connected(false);
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([0xff])));
    socket.serverCloses();
    await vi.advanceTimersByTimeAsync(1000);
    const next = latest();
    next.serverOpens();
    next.receiveFrame(createDeltaFrame(1, new Uint8Array([0xff])));
    expect(next.types()).toEqual(["__reconnect", "__reconnect"]);
  });

  it("nothing to ask with before any view applied (the first snapshot did not decode)", async () => {
    const client = makeClient(false);
    client.connect();
    await settle();
    latest().serverOpens();
    latest().receiveFrame(new Uint8Array([1, 1, 0, 0, 0, 9]));
    expect(latest().sent).toEqual([]);
  });
});
