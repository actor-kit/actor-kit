import { actorClient, createActorClient } from "@actor-kit/client";
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

describe("optional accessToken", () => {
  it("connects without subprotocol when accessToken is omitted", async () => {
    let capturedProtocols: string | string[] | undefined;
    const client = createActorClient({
      url: "wss://example.com/api/counter/test-1",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    // No subprotocol should be sent
    expect(capturedProtocols).toBeUndefined();
    client.disconnect();
  });

  it("connects with token subprotocol when accessToken is provided (backwards compat)", async () => {
    let capturedProtocols: string | string[] | undefined;
    const client = createActorClient({
      url: "wss://example.com/api/counter/test-1",
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
    client.disconnect();
  });

  it("receives snapshot and updates view without token", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      url: "wss://example.com/api/counter/test-1",
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
        data: { count: 42 },
      }),
    );

    expect(client.view).toEqual({ count: 42 });
    expect(client.connectionState).toBe("connected");
    client.disconnect();
  });

  it("sends messages without token", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      url: "wss://example.com/api/counter/test-1",
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

    client.send({ type: "INCREMENT" });
    expect(fakeWs?.sent).toHaveLength(1);
    expect(JSON.parse(fakeWs?.sent[0] ?? "")).toEqual({ type: "INCREMENT" });
    client.disconnect();
  });
});

describe("actorClient builder — optional accessToken", () => {
  it("CreateOptions accepts no accessToken", async () => {
    let capturedProtocols: string | string[] | undefined;
    const factory = actorClient({
      name: "counter",
      def: {
        roles: { user: () => true },
        messages: {},
        views: {},
      },
    });

    const client = factory.create({
      url: "wss://example.com/api/counter/test-1",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toBeUndefined();
    client.disconnect();
  });

  it("CreateOptions with accessToken sends subprotocol", async () => {
    let capturedProtocols: string | string[] | undefined;
    const factory = actorClient({
      name: "counter",
      def: {
        roles: { user: () => true },
        messages: {},
        views: {},
      },
    });

    const client = factory.create({
      url: "wss://example.com/api/counter/test-1",
      accessToken: "my-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["token.my-token"]);
    client.disconnect();
  });
});
