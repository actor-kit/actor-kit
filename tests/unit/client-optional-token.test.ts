import { actorClient, createActorClient } from "@actor-kit/client";
import { describe, expect, it } from "vitest";

class FakeWebSocket {
  listeners = new Map<string, Set<Function>>();
  sent: string[] = [];
  readyState = 1;
  protocol = "";

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    if (Array.isArray(protocols)) this.protocol = protocols[0] ?? "";
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
    this.readyState = 3;
    this.fireEvent("close", { code: 1000 });
  }

  fireEvent(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
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

describe("optional getToken", () => {
  it("connects with only the actor-kit.v1 protocol when getToken is omitted", async () => {
    let capturedProtocols: string | string[] | undefined;
    const client = createActorClient({
      ...baseOptions,
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["actor-kit.v1"]);
    client.disconnect();
  });

  it("connects with auth.<token> protocol when getToken is provided", async () => {
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
    client.disconnect();
  });

  it("receives snapshot and updates view without token", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 42 } }));

    expect(client.view).toEqual({ count: 42 });
    expect(client.connectionState).toBe("connected");
    client.disconnect();
  });

  it("sends messages without token", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const client = createActorClient({
      ...baseOptions,
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

    client.send({ type: "INCREMENT" });
    expect(fakeWs?.sent).toHaveLength(1);
    expect(JSON.parse(fakeWs?.sent[0] ?? "")).toEqual({ type: "INCREMENT" });
    client.disconnect();
  });
});

describe("actorClient builder — optional getToken", () => {
  it("CreateOptions accepts no getToken", async () => {
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
      ...baseOptions,
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["actor-kit.v1"]);
    client.disconnect();
  });

  it("CreateOptions with getToken sends auth subprotocol", async () => {
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
      ...baseOptions,
      getToken: () => "my-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = protocols;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["actor-kit.v1", "auth.my-token"]);
    client.disconnect();
  });
});
