import { describe, expect, it } from "vitest";
import { createActorClient } from "../../packages/actor-kit/src/client/client";

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
    // Auto-fire open after construction
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

  // Test helpers
  fireEvent(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(data);
    }
  }

  receiveMessage(data: string) {
    this.fireEvent("message", { data });
  }
}

describe("createActorClient()", () => {
  it("creates a client with initial disconnected state", () => {
    const client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(client.connectionState).toBe("connecting");
  });

  it("receives initial snapshot and updates view", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    // Wait for connection
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeWs).toBeDefined();

    // Server sends snapshot
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
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));

    const views: unknown[] = [];
    client.subscribe((view) => views.push(view));

    fakeWs?.receiveMessage(
      JSON.stringify({
        type: "snapshot",
        role: "user",
        data: { count: 1 },
      }),
    );

    fakeWs?.receiveMessage(
      JSON.stringify({
        type: "snapshot",
        role: "user",
        data: { count: 2 },
      }),
    );

    expect(views).toHaveLength(2);
    expect(views[0]).toEqual({ count: 1 });
    expect(views[1]).toEqual({ count: 2 });
  });

  it("send() dispatches message via WebSocket", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Send initial snapshot so client is "connected"
    fakeWs?.receiveMessage(
      JSON.stringify({
        type: "snapshot",
        role: "user",
        data: { count: 0 },
      }),
    );

    client.send({ type: "INCREMENT", amount: 5 });

    expect(fakeWs?.sent).toHaveLength(1);
    expect(JSON.parse(fakeWs?.sent[0] ?? "")).toEqual({ type: "INCREMENT", amount: 5 });
  });

  it("trigger shorthand constructs message", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(
      JSON.stringify({
        type: "snapshot",
        role: "user",
        data: { count: 0 },
      }),
    );

    client.trigger("INCREMENT", { amount: 5 });

    expect(fakeWs?.sent).toHaveLength(1);
    expect(JSON.parse(fakeWs?.sent[0] ?? "")).toEqual({ type: "INCREMENT", amount: 5 });
  });

  it("disconnect() closes WebSocket", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(
      JSON.stringify({
        type: "snapshot",
        role: "user",
        data: {},
      }),
    );

    client.disconnect();
    expect(client.connectionState).toBe("disconnected");
  });

  it("unsubscribe stops listener", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));

    const views: unknown[] = [];
    const unsub = client.subscribe((view) => views.push(view));

    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 1 } }));
    unsub();
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 2 } }));

    expect(views).toHaveLength(1); // Only the first one
  });

  it("connects with Sec-WebSocket-Protocol for auth", async () => {
    let capturedProtocols: string | string[] | undefined;
    const _client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "my-jwt-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["token.my-jwt-token"]);
  });

  it("constructs correct WebSocket URL", async () => {
    let capturedUrl: string | undefined;
    const _client = createActorClient({
      actorType: "counter",
      actorId: "test-1",
      host: "example.com",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("wss://example.com/api/counter/test-1");
  });
});
