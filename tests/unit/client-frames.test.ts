// @vitest-environment jsdom
/**
 * createActorClient(): what each server frame does to the client's view, role, state and callbacks,
 * plus the send queue and connect() idempotence. Seam: a hand-driven fake socket; no internals mocked.
 */

import { createActorClient } from "@actor-kit/client";
import {
  ControlType,
  createControlFrame,
  createDeltaFrame,
  createSnapshotFrame,
  encode,
  schema,
  string,
  uint32,
} from "@actor-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { data?: unknown }) => void;

class ManualSocket {
  static created: ManualSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sent: string[] = [];
  readyState = 0;
  binaryType = "blob";

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
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

  receiveJson(message: unknown): void {
    this.receive(JSON.stringify(message));
  }

  receiveFrame(bytes: Uint8Array): void {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.receive(copy);
  }

  sentMessages(): unknown[] {
    return this.sent.map((raw): unknown => JSON.parse(raw));
  }
}

function latest(): ManualSocket {
  const socket = ManualSocket.created.at(-1);
  if (!socket) throw new Error("no socket created");
  return socket;
}

const Counter = schema({ count: uint32 });
const OwnerView = schema({ count: uint32, secret: string });
const ViewerView = schema({ count: uint32 });

const clients: Array<{ disconnect(): void }> = [];
function track<T extends { disconnect(): void }>(client: T): T {
  clients.push(client);
  return client;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function jsonClient(extra: { onRedirect?: (t: { actorType: string; actorId: string }) => void } = {}) {
  const errors: Array<{ message: string; error: string }> = [];
  const client = track(
    createActorClient({
      path: "/api/counter/c1",
      host: "example.com",
      initialView: { count: 0, role: "guest" },
      WebSocketImpl: ManualSocket,
      onError: (e) => errors.push(e),
      onRedirect: extra.onRedirect,
    }),
  );
  return { client, errors };
}

function binaryClient(initialView: unknown) {
  return track(
    createActorClient({
      path: "/api/counter/c1",
      host: "example.com",
      initialView,
      viewSchema: Counter,
      WebSocketImpl: ManualSocket,
    }),
  );
}

async function connected<T extends { connect(): void }>(client: T): Promise<ManualSocket> {
  client.connect();
  await settle();
  const socket = latest();
  socket.serverOpens();
  return socket;
}

beforeEach(() => {
  ManualSocket.created = [];
  vi.useFakeTimers();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});

describe("binary snapshot frames", () => {
  it("decodes the view, marks the client connected and notifies subscribers", async () => {
    const client = binaryClient({ count: 0 });
    const seen: unknown[] = [];
    client.subscribe((view) => seen.push(view));
    const socket = await connected(client);
    expect(client.connectionState).toBe("connecting");

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 9 })));

    expect(client.view).toEqual({ count: 9 });
    expect(client.connectionState).toBe("connected");
    expect(seen).toEqual([{ count: 9 }]);
  });

  it("keeps the role from initialView when the client has no role list", async () => {
    const client = binaryClient({ count: 0, role: "owner" });
    const socket = await connected(client);

    socket.receiveFrame(createSnapshotFrame(1, 3, encode(Counter, { count: 1 })));

    expect(client.role).toBe("owner");
  });

  it("ignores binary frames when it has no schema to decode them", async () => {
    const { client } = jsonClient();
    const seen: unknown[] = [];
    client.subscribe((view) => seen.push(view));
    const socket = await connected(client);

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 9 })));
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([0])));

    expect(client.view).toEqual({ count: 0, role: "guest" });
    expect(client.connectionState).toBe("connecting");
    expect(seen).toEqual([]);
  });

  it("ignores a frame it cannot parse", async () => {
    const client = binaryClient({ count: 0 });
    const socket = await connected(client);
    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 4 })));

    socket.receiveFrame(new Uint8Array([1, 2]));

    expect(client.view).toEqual({ count: 4 });
  });

  it("ignores socket data that is neither text nor an ArrayBuffer", async () => {
    const client = binaryClient({ count: 0 });
    const socket = await connected(client);

    socket.receive(new Uint8Array([1, 2, 3]));
    socket.receive(42);

    expect(client.view).toEqual({ count: 0 });
  });
});

describe("binary delta frames", () => {
  it("applies the delta and notifies subscribers", async () => {
    const client = binaryClient({ count: 0 });
    const socket = await connected(client);
    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 1 })));
    const seen: unknown[] = [];
    client.subscribe((view) => seen.push(view));

    // bitmask 0b1 (count changed) + uint32 big-endian 5
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([1, 0, 0, 0, 5])));

    expect(client.view).toEqual({ count: 5 });
    expect(seen).toEqual([{ count: 5 }]);
  });

  it("ignores a delta before any view object exists", async () => {
    const client = binaryClient(undefined);
    const seen: unknown[] = [];
    client.subscribe((view) => seen.push(view));
    const socket = await connected(client);

    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([0])));

    expect(client.view).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("keeps decoding deltas with the last good schema after a snapshot it could not decode", async () => {
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchemas: { owner: OwnerView },
        roleNames: ["owner", "viewer"],
        WebSocketImpl: ManualSocket,
      }),
    );
    const socket = await connected(client);
    socket.receiveFrame(createSnapshotFrame(1, 0, encode(OwnerView, { count: 1, secret: "s" })));

    socket.receiveFrame(createSnapshotFrame(1, 1, encode(ViewerView, { count: 2 }))); // no schema for "viewer"
    socket.receiveFrame(createDeltaFrame(1, new Uint8Array([1, 0, 0, 0, 3])));

    expect(client.view).toEqual({ count: 3, secret: "s" });
    expect(client.role).toBe("owner");
  });
});

describe("per-role schemas", () => {
  function roleClient() {
    return track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchema: Counter,
        viewSchemas: { owner: OwnerView, viewer: ViewerView },
        roleNames: ["owner", "viewer", "auditor"],
        WebSocketImpl: ManualSocket,
      }),
    );
  }

  it("decodes with the schema of the frame's role and exposes the role name", async () => {
    const client = roleClient();
    const socket = await connected(client);

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(OwnerView, { count: 1, secret: "x" })));
    expect(client.view).toEqual({ count: 1, secret: "x" });
    expect(client.role).toBe("owner");

    socket.receiveFrame(createSnapshotFrame(1, 1, encode(ViewerView, { count: 2 })));
    expect(client.view).toEqual({ count: 2 });
    expect(client.role).toBe("viewer");
  });

  it("falls back to viewSchema for a role without its own schema", async () => {
    const client = roleClient();
    const socket = await connected(client);

    socket.receiveFrame(createSnapshotFrame(1, 2, encode(Counter, { count: 7 })));

    expect(client.view).toEqual({ count: 7 });
    expect(client.role).toBe("auditor");
  });

  it("uses viewSchema when it has role names but no per-role schemas", async () => {
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchema: Counter,
        roleNames: ["owner"],
        WebSocketImpl: ManualSocket,
      }),
    );
    const socket = await connected(client);

    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 6 })));

    expect(client.view).toEqual({ count: 6 });
    expect(client.role).toBe("owner");
  });

  it("falls back to viewSchema for a role index outside the role list", async () => {
    const client = roleClient();
    const socket = await connected(client);

    socket.receiveFrame(createSnapshotFrame(1, 9, encode(Counter, { count: 8 })));

    expect(client.view).toEqual({ count: 8 });
    expect(client.role).toBeUndefined();
  });
});

describe("control frames", () => {
  async function redirectsFrom(payload: string) {
    const targets: Array<{ actorType: string; actorId: string }> = [];
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: { count: 0 },
        viewSchema: Counter,
        WebSocketImpl: ManualSocket,
        onRedirect: (t) => targets.push(t),
      }),
    );
    const socket = await connected(client);
    socket.receiveFrame(createControlFrame(ControlType.REDIRECT, new TextEncoder().encode(payload)));
    return targets;
  }

  it("reports a redirect target", async () => {
    expect(await redirectsFrom(JSON.stringify({ actorType: "room", actorId: "r2" }))).toEqual([
      { actorType: "room", actorId: "r2" },
    ]);
  });

  it("fills a missing or non-string half of the target with an empty string", async () => {
    expect(await redirectsFrom(JSON.stringify({ actorId: "r3" }))).toEqual([{ actorType: "", actorId: "r3" }]);
    expect(await redirectsFrom(JSON.stringify({ actorType: "room", actorId: 4 }))).toEqual([
      { actorType: "room", actorId: "" },
    ]);
  });

  it("reports a redirect that names only the actor type", async () => {
    expect(await redirectsFrom(JSON.stringify({ actorType: "room" }))).toEqual([{ actorType: "room", actorId: "" }]);
  });

  it("ignores a control payload that is not a redirect", async () => {
    expect(await redirectsFrom(JSON.stringify({ other: 1 }))).toEqual([]);
    expect(await redirectsFrom("not json")).toEqual([]);
    expect(await redirectsFrom("null")).toEqual([]);
  });

  it("does not throw on a redirect without an onRedirect handler", async () => {
    const client = binaryClient({ count: 0 });
    const socket = await connected(client);

    expect(() =>
      socket.receiveFrame(
        createControlFrame(ControlType.REDIRECT, new TextEncoder().encode(JSON.stringify({ actorId: "x" }))),
      ),
    ).not.toThrow();
  });
});

describe("JSON messages", () => {
  it("applies a snapshot, keeping the role when the message has none", async () => {
    const { client } = jsonClient();
    const socket = await connected(client);

    socket.receiveJson({ type: "snapshot", data: { count: 2 } });
    expect(client.view).toEqual({ count: 2 });
    expect(client.role).toBe("guest");
    expect(client.connectionState).toBe("connected");

    socket.receiveJson({ type: "snapshot", role: "admin", data: { count: 3 } });
    expect(client.role).toBe("admin");
    socket.receiveJson({ type: "snapshot", role: 5, data: { count: 4 } });
    expect(client.role).toBe("admin");
  });

  it("reports a __redirect", async () => {
    const targets: Array<{ actorType: string; actorId: string }> = [];
    const { client } = jsonClient({ onRedirect: (t) => targets.push(t) });
    const socket = await connected(client);

    socket.receiveJson({ type: "__redirect", actorType: "room", actorId: "r9" });
    socket.receiveJson({ type: "__redirect" });

    expect(targets).toEqual([
      { actorType: "room", actorId: "r9" },
      { actorType: "", actorId: "" },
    ]);
  });

  it("does not throw on a __redirect without an onRedirect handler", async () => {
    const { client } = jsonClient();
    const socket = await connected(client);

    expect(() => socket.receiveJson({ type: "__redirect", actorId: "x" })).not.toThrow();
  });

  it("marks the client connected on __reconnect_ack", async () => {
    const { client } = jsonClient();
    const socket = await connected(client);
    expect(client.connectionState).toBe("connecting");

    socket.receiveJson({ type: "__reconnect_ack", checksum: "abc" });

    expect(client.connectionState).toBe("connected");
  });

  it("reports an __error frame's refusal; a frame it cannot read is invalid_frame", async () => {
    const { client, errors } = jsonClient();
    const socket = await connected(client);

    socket.receiveJson({
      type: "__error",
      messageType: "ADD",
      code: "invalid_payload",
      message: "Validation failed.",
      expected: ["n"],
      details: [{ path: ["n"] }],
      docs: "https://actorkit.dev/errors/invalid_payload/",
    });
    socket.receiveJson({ type: "__error", code: "no_role", message: "No role.", docs: "d", expected: ["n", 2] });
    socket.receiveJson({ type: "__error", messageType: "X", code: "nope", message: "m", docs: "d" });
    socket.receiveJson({ type: "__error", code: "no_role", message: 5, docs: "d" });
    socket.receiveJson({ type: "__error", code: "no_role", message: "m" });

    const invalid = {
      code: "invalid_frame",
      message:
        "The server sent an error frame this client cannot read. Use the same @actor-kit version on the client and the Worker.",
      docs: "https://actorkit.dev/errors/invalid_frame/",
    };
    expect(errors).toStrictEqual([
      {
        messageType: "ADD",
        code: "invalid_payload",
        message: "Validation failed.",
        expected: ["n"],
        details: [{ path: ["n"] }],
        docs: "https://actorkit.dev/errors/invalid_payload/",
      },
      { messageType: "", code: "no_role", message: "No role.", docs: "d" },
      { messageType: "X", ...invalid },
      { messageType: "", ...invalid },
      { messageType: "", ...invalid },
    ]);
  });

  it("does not throw on __error without an onError handler", async () => {
    const client = binaryClient({ count: 0 });
    const socket = await connected(client);

    expect(() => socket.receiveJson({ type: "__error", detail: "x" })).not.toThrow();
  });

  it("ignores text that is not a JSON object, and unknown message types", async () => {
    const { client, errors } = jsonClient();
    const socket = await connected(client);

    expect(() => {
      socket.receive("null");
      socket.receive("42");
      socket.receive("{not json");
      socket.receiveJson({ type: "something-else", data: { count: 9 } });
    }).not.toThrow();

    expect(client.view).toEqual({ count: 0, role: "guest" });
    expect(client.connectionState).toBe("connecting");
    expect(errors).toEqual([]);
  });
});

describe("state listeners", () => {
  it("fires once per change and stops after unsubscribe", async () => {
    const { client } = jsonClient();
    const states: string[] = [];
    const off = client.onStateChange((s) => states.push(s));
    const socket = await connected(client);
    socket.receiveJson({ type: "snapshot", data: { count: 1 } });
    socket.receiveJson({ type: "snapshot", data: { count: 2 } });
    socket.receiveJson({ type: "__reconnect_ack" });

    off();
    socket.serverCloses();

    expect(states).toEqual(["connecting", "connected"]);
  });
});

describe("send() and connect()", () => {
  it("drops messages sent before connect()", async () => {
    const { client } = jsonClient();
    client.send({ type: "EARLY" });
    const socket = await connected(client);

    expect(socket.sentMessages()).toEqual([]);
  });

  it("queues messages sent while connecting and sends them in order on open", async () => {
    const { client } = jsonClient();
    client.connect();
    await settle();
    client.send({ type: "A" });
    client.trigger("B", { n: 1 });

    latest().serverOpens();

    expect(latest().sentMessages()).toEqual([{ type: "A" }, { type: "B", n: 1 }]);
  });

  it("sends directly once open", async () => {
    const { client } = jsonClient();
    const socket = await connected(client);

    client.send({ type: "NOW" });

    expect(socket.sentMessages()).toEqual([{ type: "NOW" }]);
  });

  it("drops the queue on disconnect()", async () => {
    const { client } = jsonClient();
    client.connect();
    await settle();
    client.send({ type: "LOST" });
    client.disconnect();
    client.connect();
    await settle();
    latest().serverOpens();

    expect(latest().sentMessages()).toEqual([]);
  });

  it("is idempotent while connecting or connected", async () => {
    const { client } = jsonClient();
    client.connect();
    client.connect();
    await settle();
    expect(ManualSocket.created).toHaveLength(1);

    latest().serverOpens();
    latest().receiveJson({ type: "snapshot", data: { count: 1 } });
    client.connect();
    await settle();

    expect(ManualSocket.created).toHaveLength(1);
  });

  it("stays 'reconnecting' when connect() runs during a reconnect wait", async () => {
    const { client } = jsonClient();
    const states: string[] = [];
    const socket = await connected(client);
    socket.serverCloses();
    client.onStateChange((s) => states.push(s));

    client.connect();
    await settle();

    expect(client.connectionState).toBe("reconnecting");
    expect(states).toEqual([]);
  });

  it("asks for array buffers so binary frames arrive decodable", async () => {
    const { client } = jsonClient();
    client.connect();
    await settle();

    expect(latest().binaryType).toBe("arraybuffer");
  });

  it("does not send __reconnect after a manual disconnect() and connect()", async () => {
    const client = binaryClient({ count: 0 });
    const socket = await connected(client);
    socket.receiveFrame(createSnapshotFrame(1, 0, encode(Counter, { count: 1 })));

    client.disconnect();
    client.connect();
    await settle();
    latest().serverOpens();

    expect(latest().sentMessages()).toEqual([]);
  });

  it("stays disconnected when getToken rejects after disconnect()", async () => {
    let reject: (e: Error) => void = () => {};
    const client = track(
      createActorClient({
        path: "/api/counter/c1",
        host: "example.com",
        initialView: undefined,
        getToken: () =>
          new Promise<string>((_resolve, r) => {
            reject = r;
          }),
        WebSocketImpl: ManualSocket,
      }),
    );
    client.connect();
    client.disconnect();
    reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.connectionState).toBe("disconnected");
    expect(ManualSocket.created).toHaveLength(0);
  });
});

describe("browser listeners", () => {
  it("disconnect() removes the online/visibility listeners connect() added", async () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const winAdd = vi.spyOn(window, "addEventListener").mockImplementation((t, l) => added.push([t, l]));
    const winRemove = vi.spyOn(window, "removeEventListener").mockImplementation((t, l) => removed.push([t, l]));
    const docAdd = vi.spyOn(document, "addEventListener").mockImplementation((t, l) => added.push([t, l]));
    const docRemove = vi.spyOn(document, "removeEventListener").mockImplementation((t, l) => removed.push([t, l]));
    try {
      const { client } = jsonClient();
      client.connect();
      await settle();
      expect(added.map(([t]) => t).sort()).toEqual(["online", "visibilitychange"]);

      client.disconnect();
      expect(removed).toEqual(expect.arrayContaining(added));
      expect(removed).toHaveLength(2);
    } finally {
      winAdd.mockRestore();
      winRemove.mockRestore();
      docAdd.mockRestore();
      docRemove.mockRestore();
    }
  });
});
