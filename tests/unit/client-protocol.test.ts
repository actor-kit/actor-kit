import { createActorClient } from "@actor-kit/client";
import { describe, expect, it } from "vitest";

/** A listener the fake socket calls with its event. */
type Listener = (event: unknown) => void;

class FakeWebSocket {
  url: string;
  listeners = new Map<string, Set<Listener>>();
  readyState = 1;
  protocol = "";
  binaryType = "blob";
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    if (Array.isArray(protocols)) this.protocol = protocols[0] ?? "";
    setTimeout(() => this.fireEvent("open", {}), 0);
  }

  addEventListener(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(fn);
  }

  removeEventListener(event: string, fn: Listener) {
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
  it("infers ws:// for localhost host", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      path: "/api/counter/test",
      host: "localhost:8787",
      initialView: undefined,
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
    expect(capturedUrl).toBe("ws://localhost:8787/api/counter/test");
    client.disconnect();
  });

  it("infers wss:// for public host", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      path: "/api/counter/test",
      host: "example.com",
      initialView: undefined,
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
    expect(capturedUrl).toBe("wss://example.com/api/counter/test");
    client.disconnect();
  });

  it("connects to custom path", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      path: "/game/zones/forest-north",
      host: "example.com",
      initialView: undefined,
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
    expect(capturedUrl).toBe("wss://example.com/game/zones/forest-north");
    client.disconnect();
  });

  it("fires error callback when server sends __error frame", async () => {
    let fakeWs: FakeWebSocket | undefined;
    const errors: unknown[] = [];

    const client = createActorClient({
      path: "/api/counter/test",
      host: "example.com",
      initialView: undefined,
      getToken: () => "token",
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
    client.connect();

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
