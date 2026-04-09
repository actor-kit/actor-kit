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

  removeEventListener(_event: string, _fn: Function) {}

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

describe("client URL routing", () => {
  it("builds URL from path + host", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      path: "/my/custom/path",
      host: "custom.host",
      initialView: undefined,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("wss://custom.host/my/custom/path");
    client.disconnect();
  });

  it("sends auth token via subprotocol", async () => {
    let capturedProtocols: string[] = [];
    const client = createActorClient({
      path: "/actors/my-actor",
      host: "custom.host",
      initialView: undefined,
      getToken: () => "my-secret-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedProtocols = Array.isArray(protocols) ? protocols : [];
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedProtocols).toEqual(["actor-kit.v1", "auth.my-secret-token"]);
    client.disconnect();
  });

  it("uses ws:// for localhost", async () => {
    let capturedUrl = "";
    const client = createActorClient({
      path: "/game/zones/forest",
      host: "localhost:8787",
      initialView: undefined,
      getToken: () => "test-token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });
    client.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(capturedUrl).toBe("ws://localhost:8787/game/zones/forest");
    client.disconnect();
  });
});
