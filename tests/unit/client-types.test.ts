import { createActorClient } from "@actor-kit/client";
import { schema, string, uint32 } from "@actor-kit/core";
import { describe, expectTypeOf, it } from "vitest";

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

const initialView = { count: 0, lastUpdatedBy: "" };

describe("typed ActorClient", () => {
  it("infers view type from viewSchema", () => {
    const client = createActorClient<typeof CounterView.shape, CounterEvent>({
      path: "/counter",
      host: "example.com",
      initialView,
      getToken: () => "token",
      viewSchema: CounterView,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expectTypeOf(client.view).toEqualTypeOf<{ count: number; lastUpdatedBy: string }>();

    client.disconnect();
  });

  it("subscribe callback receives typed view", () => {
    const client = createActorClient<typeof CounterView.shape, CounterEvent>({
      path: "/counter",
      host: "example.com",
      initialView,
      getToken: () => "token",
      viewSchema: CounterView,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.subscribe((view) => {
      expectTypeOf(view).toEqualTypeOf<{ count: number; lastUpdatedBy: string }>();
    });

    client.disconnect();
  });

  it("send accepts typed event union", () => {
    const client = createActorClient<typeof CounterView.shape, CounterEvent>({
      path: "/counter",
      host: "example.com",
      initialView,
      getToken: () => "token",
      viewSchema: CounterView,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.send({ type: "INCREMENT" });
    client.send({ type: "DECREMENT" });
    client.send({ type: "RESET" });

    // @ts-expect-error — INVALID is not a valid event type
    client.send({ type: "INVALID" });

    client.disconnect();
  });

  it("client without viewSchema has unknown view (when initialView is unknown)", () => {
    const client = createActorClient<unknown>({
      path: "/counter",
      host: "example.com",
      initialView: undefined,
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expectTypeOf(client.view).toEqualTypeOf<unknown>();

    client.disconnect();
  });
});
