import { describe, it, expect, vi } from "vitest";
import { createActorClient } from "../../packages/actor-kit/src/client/client";

// Controllable fake WebSocket
class FakeWebSocket {
  listeners = new Map<string, Set<Function>>();
  sent: string[] = [];
  readyState = 1;
  protocol = "";

  constructor(public url: string, public protocols?: string | string[]) {
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

  send(data: string) { this.sent.push(data); }

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

describe("client reconnection", () => {
  it("transitions to reconnecting on unexpected close", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const stateChanges: string[] = [];

    const client = createActorClient({
      actorType: "counter",
      actorId: "test",
      host: "example.com",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    client.onStateChange((state) => stateChanges.push(state));

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: { count: 0 } }));

    expect(client.connectionState).toBe("connected");

    // Simulate unexpected close (server restart, network blip)
    fakeWs?.fireEvent("close", { code: 1006 });

    expect(client.connectionState).toBe("reconnecting");
    expect(stateChanges).toContain("reconnecting");
  });

  it("stays disconnected on intentional close", async () => {
    let fakeWs: FakeWebSocket | undefined;

    const client = createActorClient({
      actorType: "counter",
      actorId: "test",
      host: "example.com",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: {} }));

    client.disconnect();
    expect(client.connectionState).toBe("disconnected");
  });

  it("onStateChange fires on connect → connected", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const stateChanges: string[] = [];

    const client = createActorClient({
      actorType: "counter",
      actorId: "test",
      host: "example.com",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    client.onStateChange((state) => stateChanges.push(state));

    await new Promise((r) => setTimeout(r, 10));
    fakeWs?.receiveMessage(JSON.stringify({ type: "snapshot", role: "user", data: {} }));

    expect(stateChanges).toContain("connected");
  });
});
