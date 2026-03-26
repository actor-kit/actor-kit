import { createActorClient } from "@actor-kit/client";
import { describe, expect, it } from "vitest";

class FakeWebSocket {
  url: string;
  listeners = new Map<string, Set<Function>>();
  readyState = 1;
  protocol = "";
  binaryType = "blob";
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
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
  }

  fireEvent(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
  }
}

describe("client protocol handling", () => {
  it("connects to ws:// URL for local development", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      url: "ws://localhost:8787/api/counter/test",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("ws://localhost:8787/api/counter/test");
    client.disconnect();
  });

  it("connects to wss:// URL for production", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      url: "wss://example.com/api/counter/test",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("wss://example.com/api/counter/test");
    client.disconnect();
  });

  it("connects to custom path URL", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      url: "wss://example.com/game/zones/forest-north",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("wss://example.com/game/zones/forest-north");
    client.disconnect();
  });

  it("fires error callback when server sends __error frame", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const errors: unknown[] = [];

    const client = createActorClient({
      url: "wss://example.com/api/counter/test",
      accessToken: "token",
      onError: (error) => {
        errors.push(error);
      },
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          fakeWs = this;
        }
      } as unknown as typeof WebSocket,
    });

    await new Promise((r) => setTimeout(r, 10));

    fakeWs?.fireEvent("message", {
      data: JSON.stringify({ type: "snapshot", role: "user", data: { count: 0 } }),
    });

    fakeWs?.fireEvent("message", {
      data: JSON.stringify({ type: "__error", message: "INCREMENT", error: "guard_failed" }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ message: "INCREMENT", error: "guard_failed" });

    client.disconnect();
  });
});
