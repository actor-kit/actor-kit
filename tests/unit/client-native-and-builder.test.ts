/**
 * Node environment (no window): native upgrade headers, URL protocol inference edge cases, and the
 * actorClient() builder choosing per-role schemas from a contract.
 */

import { actorClient, createActorClient, inferProtocol } from "@actor-kit/client";
import { createSnapshotFrame, encode, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

type Listener = (event: { data?: unknown }) => void;

class RecordingSocket {
  static created: RecordingSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readyState = 0;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
    RecordingSocket.created.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(): void {}
  close(): void {}

  receiveFrame(bytes: Uint8Array): void {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    for (const listener of this.listeners.get("message") ?? []) listener({ data: copy });
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function latest(): RecordingSocket {
  const socket = RecordingSocket.created.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
}

describe("native WebSocket headers (no window)", () => {
  it("passes getHeaders() as the third constructor argument", async () => {
    const client = createActorClient({
      path: "/api/counter/c1",
      host: "example.com",
      initialView: undefined,
      getToken: () => "t",
      getHeaders: async () => ({ authorization: "Bearer abc" }),
      WebSocketImpl: RecordingSocket,
    });
    client.connect();
    await flush();

    expect(latest().protocols).toEqual(["actor-kit.v1", "auth.t"]);
    expect(latest().options).toEqual({ headers: { authorization: "Bearer abc" } });
    client.disconnect();
  });

  it("passes no options bag without getHeaders", async () => {
    const client = createActorClient({
      path: "/api/counter/c1",
      host: "example.com",
      initialView: undefined,
      WebSocketImpl: RecordingSocket,
    });
    client.connect();
    await flush();

    expect(latest().protocols).toEqual(["actor-kit.v1"]);
    expect(latest().options).toBeUndefined();
    client.disconnect();
  });
});

describe("inferProtocol edge cases", () => {
  it("only treats a full dotted-quad hostname as an IP", () => {
    expect(inferProtocol("10.0.0.12:8787")).toBe("ws");
    expect(inferProtocol("1.2.33.4")).toBe("ws");
    expect(inferProtocol("x1.2.3.4")).toBe("wss");
    expect(inferProtocol("1.2.3.4.example.com")).toBe("wss");
  });
});

const OwnerView = schema({ count: uint32, secret: string });
const ViewerView = schema({ count: uint32 });

function contract(def: Record<string, unknown>) {
  return { name: "counter", def };
}

async function decodeWith(
  factory: {
    create(o: { path: string; host: string; initialView: unknown; WebSocketImpl: typeof RecordingSocket }): {
      connect(): void;
      disconnect(): void;
      readonly view: unknown;
      readonly role: string | undefined;
    };
  },
  frame: Uint8Array,
) {
  const client = factory.create({
    path: "/a/b",
    host: "example.com",
    initialView: { start: true },
    WebSocketImpl: RecordingSocket,
  });
  client.connect();
  await flush();
  latest().receiveFrame(frame);
  const result = { view: client.view, role: client.role };
  client.disconnect();
  return result;
}

describe("actorClient(contract)", () => {
  const roles = { owner: () => true, viewer: () => true };
  const views = { owner: { schema: OwnerView }, viewer: { schema: ViewerView } };

  it("decodes each role's frames with that role's view schema and names the role", async () => {
    const factory = actorClient(contract({ roles, views }));

    expect(await decodeWith(factory, createSnapshotFrame(1, 0, encode(OwnerView, { count: 1, secret: "s" })))).toEqual({
      view: { count: 1, secret: "s" },
      role: "owner",
    });
    expect(await decodeWith(factory, createSnapshotFrame(1, 1, encode(ViewerView, { count: 2 })))).toEqual({
      view: { count: 2 },
      role: "viewer",
    });
  });

  it("keeps per-role decoding through .messages() and .events()", async () => {
    const factory = actorClient(contract({ roles, views }));
    const frame = createSnapshotFrame(1, 1, encode(ViewerView, { count: 5 }));

    expect((await decodeWith(factory.messages<{ type: "A" }>(), frame)).view).toEqual({ count: 5 });
    expect((await decodeWith(factory.events<{ type: "A" }>(), frame)).view).toEqual({ count: 5 });
  });

  it("ignores binary frames for a role whose view has no schema", async () => {
    const factory = actorClient(contract({ roles, views: { owner: { schema: OwnerView }, viewer: { fn: () => 1 } } }));

    expect(await decodeWith(factory, createSnapshotFrame(1, 1, encode(ViewerView, { count: 2 })))).toEqual({
      view: { start: true },
      role: undefined,
    });
  });

  it("ignores binary frames when the contract has no roles or no views", async () => {
    const frame = createSnapshotFrame(1, 0, encode(OwnerView, { count: 1, secret: "s" }));

    expect((await decodeWith(actorClient(contract({ views })), frame)).view).toEqual({ start: true });
    expect((await decodeWith(actorClient(contract({ roles })), frame)).view).toEqual({ start: true });
    expect((await decodeWith(actorClient(contract({ roles, views: "nope" })), frame)).view).toEqual({ start: true });
  });
});

describe("actorClient(schema)", () => {
  it("decodes every snapshot with the given schema, whatever the role index", async () => {
    const factory = actorClient(ViewerView);
    const frame = createSnapshotFrame(1, 4, encode(ViewerView, { count: 3 }));

    expect(await decodeWith(factory, frame)).toEqual({ view: { count: 3 }, role: undefined });
    expect((await decodeWith(factory.messages<{ type: "A" }>(), frame)).view).toEqual({ count: 3 });
    expect((await decodeWith(factory.events<{ type: "A" }>(), frame)).view).toEqual({ count: 3 });
  });
});
