import { actorClient } from "@actor-kit/client";
import { schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- Test fixtures ---

type CounterState = { count: number; name: string };

const CounterView = schema({ count: uint32, name: string });

const Counter = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, name: "" }),
  messages: {
    INCREMENT: message(z.object({ amount: z.number() }), (state: CounterState, { amount }) => ({
      count: state.count + amount,
      name: state.name,
    })),
    RESET: message(z.object({}), (state: CounterState) => ({
      count: 0,
      name: state.name,
    })),
    RENAME: message(z.object({ newName: z.string() }), (state: CounterState, { newName }) => ({
      count: state.count,
      name: newName,
    })),
  },
  views: {
    user: view(CounterView, (state: CounterState) => ({
      count: state.count,
      name: state.name,
    })),
  },
});

// --- Fake WebSocket for runtime tests ---

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

// --- Type inference tests ---

describe("contract-derived client", () => {
  it("actorClient(contract) infers event types from flat messages", () => {
    const CounterClient = actorClient(Counter);
    const client = CounterClient.create({
      path: "/counter/test",
      host: "example.com",
      initialView: { count: 0, name: "" },
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // Valid events with correct payload types
    client.send({ type: "INCREMENT", amount: 1 });
    client.send({ type: "RESET" });
    client.send({ type: "RENAME", newName: "test" });

    // @ts-expect-error — INVALID is not a valid message name
    client.send({ type: "INVALID" });

    client.disconnect();
  });

  it("actorClient(contract) infers view type from views", () => {
    const CounterClient = actorClient(Counter);
    const client = CounterClient.create({
      path: "/counter/test",
      host: "example.com",
      initialView: { count: 0, name: "" },
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expectTypeOf(client.view).toEqualTypeOf<{ count: number; name: string } | undefined>();

    client.disconnect();
  });

  it("send() requires correct payload fields", () => {
    const CounterClient = actorClient(Counter);
    const client = CounterClient.create({
      path: "/counter/test",
      host: "example.com",
      initialView: { count: 0, name: "" },
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // @ts-expect-error — INCREMENT requires amount field
    client.send({ type: "INCREMENT" });

    // @ts-expect-error — RENAME requires newName field
    client.send({ type: "RENAME" });

    client.disconnect();
  });

  it("subscribe callback receives typed view", () => {
    const CounterClient = actorClient(Counter);
    const client = CounterClient.create({
      path: "/counter/test",
      host: "example.com",
      initialView: { count: 0, name: "" },
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.subscribe((view) => {
      expectTypeOf(view).toEqualTypeOf<{ count: number; name: string }>();
    });

    client.disconnect();
  });

  it("actorClient(contract).create() returns a working client", () => {
    const CounterClient = actorClient(Counter);
    const client = CounterClient.create({
      path: "/counter/test",
      host: "example.com",
      initialView: { count: 0, name: "" },
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(client.connectionState).toBe("disconnected");
    expect(client.view).toEqual({ count: 0, name: "" });
    expect(client.send).toBeTypeOf("function");
    expect(client.subscribe).toBeTypeOf("function");
    expect(client.disconnect).toBeTypeOf("function");

    client.disconnect();
  });

  it("view type is union when contract has multiple views", () => {
    const MultiViewSchema = schema({ total: uint32 });

    const MultiView = defineActor("multi", {
      input: z.object({}),
      init: (): CounterState => ({ count: 0, name: "" }),
      messages: {
        INC: message(z.object({}), (state: CounterState) => state),
      },
      views: {
        admin: view(CounterView, (state: CounterState) => ({
          count: state.count,
          name: state.name,
        })),
        viewer: view(MultiViewSchema, (state: CounterState) => ({
          total: state.count,
        })),
      },
    });

    const MultiClient = actorClient(MultiView);
    const client = MultiClient.create({
      path: "/multi/test",
      host: "example.com",
      initialView: { count: 0, name: "" },
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // View is a union of all view types
    expectTypeOf(client.view).toEqualTypeOf<{ count: number; name: string } | { total: number } | undefined>();

    client.disconnect();
  });
});
