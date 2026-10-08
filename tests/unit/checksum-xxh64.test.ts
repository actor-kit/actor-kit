import { createActorClient } from "@actor-kit/client";
import { createSnapshotFrame, encode, schema, string, uint32, xxh64 } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { defineActor, message } from "@actor-kit/worker/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Every checksum (client reconnect, server view, state) is xxh64 of the JSON (ADR-013).

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Set<(e: unknown) => void>>();
  sent: string[] = [];
  readyState = 1;
  protocol = "";

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.fire("open", {}), 0);
  }
  addEventListener(event: string, fn: (e: unknown) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(fn);
  }
  removeEventListener(event: string, fn: (e: unknown) => void) {
    this.listeners.get(event)?.delete(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  fire(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(data);
  }
}

const CounterView = schema({ count: uint32, lastCaller: string });

afterEach(() => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
});

describe("checksums use xxh64", () => {
  it("client sends xxh64 of its decoded view as lastChecksum on reconnect", async () => {
    vi.useFakeTimers();
    const client = createActorClient({
      path: "/api/counter/x",
      host: "example.com",
      initialView: undefined,
      viewSchema: CounterView,
      getToken: () => "token",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(1);

    const view = { count: 7, lastCaller: "alice" };
    const frame = createSnapshotFrame(1, 0, encode(CounterView, view));
    FakeWebSocket.instances[0]?.fire("message", { data: frame.buffer });
    FakeWebSocket.instances[0]?.fire("close", { code: 1006 });

    await vi.advanceTimersByTimeAsync(1001);
    const reconnect = FakeWebSocket.instances[1]?.sent.map((s) => JSON.parse(s)).find((m) => m.type === "__reconnect");
    expect(reconnect).toEqual({ type: "__reconnect", lastChecksum: xxh64(JSON.stringify(view)) });
    client.disconnect();
  });

  it("testActor timeline checksum is xxh64 of the after-state", async () => {
    const Counter = defineActor("counter", {
      input: z.object({}),
      init: () => ({ count: 0 }),
      roles: { user: () => true },
      messages: {
        INC: message(z.object({}), (s: { count: number }) => ({ count: s.count + 1 })),
      },
      views: { user: { fn: (s: { count: number }) => s } },
    });
    const harness = testActor(Counter);
    const result = await harness.send(harness.init({}), "alice", { type: "INC" });
    expect(result.timeline[0]?.checksum).toBe(xxh64(JSON.stringify({ count: 1 })));
  });
});
