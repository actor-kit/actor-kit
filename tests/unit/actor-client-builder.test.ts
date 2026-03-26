import { actorClient } from "@actor-kit/client";
import { schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, expectTypeOf, it } from "vitest";

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" } | { type: "RESET" };

class FakeWebSocket {
  listeners = new Map<string, Set<Function>>();
  readyState = 1;
  protocol = "";
  binaryType = "blob";

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    setTimeout(() => this.fireEvent("open", {}), 0);
  }

  addEventListener(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(fn);
  }

  removeEventListener(_event: string, _fn: Function) {}
  send(_data: string) {}

  close() {
    this.readyState = 3;
  }

  fireEvent(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
  }
}

describe("actorClient builder", () => {
  const Counter = actorClient(CounterView).events<CounterEvent>();

  it("creates a typed client factory from schema", () => {
    expect(Counter.create).toBeDefined();
    expect(Counter.events).toBeDefined();
  });

  it(".create() returns a client with view type inferred from schema", () => {
    const client = Counter.create({
      url: "wss://example.com/counter/test",
      accessToken: "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expectTypeOf(client.view).toEqualTypeOf<{ count: number; lastUpdatedBy: string } | undefined>();

    client.disconnect();
  });

  it(".create() returns a client with typed send", () => {
    const client = Counter.create({
      url: "wss://example.com/counter/test",
      accessToken: "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // Valid events compile
    client.send({ type: "INCREMENT" });
    client.send({ type: "DECREMENT" });
    client.send({ type: "RESET" });

    // @ts-expect-error — INVALID is not a valid CounterEvent
    client.send({ type: "INVALID" });

    client.disconnect();
  });

  it(".create() connects to the provided URL", () => {
    let capturedUrl = "";
    const client = Counter.create({
      url: "wss://custom.host/game/counters/abc",
      accessToken: "token",
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedUrl = url;
        }
      } as unknown as typeof WebSocket,
    });

    expect(capturedUrl).toBe("wss://custom.host/game/counters/abc");
    client.disconnect();
  });

  it("works without .events() for loose event typing", () => {
    const LooseCounter = actorClient(CounterView);
    const client = LooseCounter.create({
      url: "wss://example.com/counter/test",
      accessToken: "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // View is still typed
    expectTypeOf(client.view).toEqualTypeOf<{ count: number; lastUpdatedBy: string } | undefined>();

    // Events are loose — any { type: string } works
    client.send({ type: "ANYTHING" });

    client.disconnect();
  });

  it("does not export .context() (React-free)", () => {
    // Builder should not have a .context() method — React bindings are in actor-kit/react
    expectTypeOf(Counter).not.toHaveProperty("context");
  });
});
