import { createActorClient } from "@actor-kit/client";
import { describe, expect, it } from "vitest";

// Fake WebSocket for testing
class FakeWebSocket {
  listeners = new Map<string, Set<Function>>();
  sent: string[] = [];
  readyState = 1; // OPEN
  protocol = "";

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    if (Array.isArray(protocols)) {
      this.protocol = protocols[0] ?? "";
    }
    setTimeout(() => this.fireEvent("open", {}), 0);
  }

  addEventListener(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(fn);
  }

  removeEventListener(event: string, fn: Function) {
    this.listeners.get(event)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.fireEvent("close", { code: 1000 });
  }

  fireEvent(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(data);
    }
  }

  receiveMessage(data: string) {
    this.fireEvent("message", { data });
  }
}

const baseOptions = {
  path: "/api/counter/test-1",
  host: "example.com",
  initialView: undefined,
};

describe("createActorClient()", () => {
  it("creates a disconnected client; connect() transitions to connecting", () => {
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(client.connectionState).toBe("disconnected");
    client.connect();
    expect(client.connectionState).toBe("connecting");
    client.disconnect();
  });

  it("receives initial snapshot and updates view", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(fakeWs).toBeDefined();

    fakeWs?.receiveMessage(
      JSON.stringify({
        type: "snapshot",
        role: "user",
        data: { count: 42, lastCaller: "alice" },
      }),
    );

    expect(client.view).toEqual({ count: 42, lastCaller: "alice" });
    expect(client.role).toBe("user");
    expect(client.connectionState).toBe("connected");
  });

  it("subscribe fires on view changes", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));

    const views: unknown[] = [];
    client.subscribe((view) => views.push(view));

    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 1 } }));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 2 } }));

    expect(views).toHaveLength(2);
    expect(views[0]).toEqual({ count: 1 });
    expect(views[1]).toEqual({ count: 2 });
  });

  it("send() dispatches message via WebSocket", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 0 } }));

    client.send({ type: "INCREMENT", amount: 5 });

    expect(fakeWs?.sent).toHaveLength(1);
    expect(JSON.parse(fakeWs?.sent[0] ?? "")).toEqual({ type: "INCREMENT", amount: 5 });
  });

  it("trigger shorthand constructs message", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 0 } }));

    client.trigger("INCREMENT", { amount: 5 });

    expect(fakeWs?.sent).toHaveLength(1);
    expect(JSON.parse(fakeWs?.sent[0] ?? "")).toEqual({ type: "INCREMENT", amount: 5 });
  });

  it("disconnect() closes WebSocket", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: {} }));

    client.disconnect();
    expect(client.connectionState).toBe("disconnected");
  });

  it("unsubscribe stops listener", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));

    const views: unknown[] = [];
    const unsub = client.subscribe((view) => views.push(view));

    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 1 } }));
    unsub();
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 2 } }));

    expect(views).toHaveLength(1);
  });

  it("connects with Sec-WebSocket-Protocol carrying actor-kit version + auth.<token>", async () => {
    let capturedProtocols: string | string[] | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "my-jwt-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["actor-kit.v1", "auth.my-jwt-token"]);
  });

  it("queues messages sent while WebSocket is reconnecting", async () => {
    const instances: FakeWebSocket[] = [];
    const client = createActorClient({
      ...baseOptions,
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          instances.push(this);
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    const ws1 = instances[0];
    expect(ws1).toBeDefined();

    ws1.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 0 } }));
    expect(client.connectionState).toBe("connected");

    client.send({ type: "INCREMENT" });
    expect(ws1.sent).toHaveLength(1);

    ws1.readyState = 3;
    ws1.fireEvent("close", { code: 1006 });
    expect(client.connectionState).toBe("reconnecting");

    client.send({ type: "INCREMENT" });
    client.send({ type: "INCREMENT" });

    await new Promise((r) => setTimeout(r, 1100));
    const ws2 = instances[1];
    expect(ws2).toBeDefined();

    expect(ws2.sent).toHaveLength(2);
    expect(JSON.parse(ws2.sent[0])).toEqual({ type: "INCREMENT" });
    expect(JSON.parse(ws2.sent[1])).toEqual({ type: "INCREMENT" });
  });

  it("constructs WebSocket URL from path + host", async () => {
    let capturedUrl: string | undefined;
    const client = createActorClient({
      ...baseOptions,
      getToken: () => "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("wss://example.com/api/counter/test-1");
  });
});

describe("createActorClient() — role before first frame", () => {
  const noSocket = {
    path: "/api/todo-list/l1",
    host: "example.com",
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  };

  it("seeds role from initialView.role so SSR renders the right role branch", () => {
    const client = createActorClient({
      ...noSocket,
      initialView: { role: "viewer", todoCount: 0, doneCount: 0 },
    });
    expect(client.role).toBe("viewer");
  });

  it("leaves role undefined when initialView has no role", () => {
    const client = createActorClient({ ...noSocket, initialView: { count: 0 } });
    expect(client.role).toBeUndefined();
  });

  it("ignores a non-string initialView.role", () => {
    const client = createActorClient({ ...noSocket, initialView: { role: 7 } });
    expect(client.role).toBeUndefined();
  });

  it("leaves role undefined when initialView is undefined", () => {
    const client = createActorClient({ ...noSocket, initialView: undefined });
    expect(client.role).toBeUndefined();
  });
});
