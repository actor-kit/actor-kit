/**
 * Workers integration tests for @actor-kit/core.
 *
 * Tests createDurableActor + defineLogic against real Durable Objects
 * in the Workers runtime via @cloudflare/vitest-pool-workers.
 *
 * Zero XState — proves the core works with plain reducers.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type CounterView = {
  count: number;
  lastUpdatedBy: string | null;
  myAccessCount: number;
};

// Type-safe stub accessor
function getCounterStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return env.COUNTER.get(id) as unknown as {
    spawn(props: {
      actorType: string;
      actorId: string;
      caller: { id: string; type: "client" | "service" };
      input: Record<string, unknown>;
    }): Promise<void>;
    send(event: { type: string; caller: { id: string; type: "client" | "service" }; [key: string]: unknown }): void;
    getSnapshot(caller: { id: string; type: "client" | "service" }): Promise<{
      checksum: string;
      snapshot: CounterView;
    }>;
  };
}

const clientCaller = { id: "user-1", type: "client" as const };
const serviceCaller = { id: "admin", type: "service" as const };

describe("createDurableActor: basic operations", () => {
  it("spawns with default state", async () => {
    const stub = getCounterStub("basic-1");

    await stub.spawn({
      actorType: "counter",
      actorId: "basic-1",
      caller: clientCaller,
      input: {},
    });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(0);
    expect(result.snapshot.lastUpdatedBy).toBeNull();
    expect(result.checksum).toBeTruthy();
  });

  it("spawns with custom input", async () => {
    const stub = getCounterStub("basic-2");

    await stub.spawn({
      actorType: "counter",
      actorId: "basic-2",
      caller: clientCaller,
      input: { initialCount: 42 },
    });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(42);
  });

  it("spawn is idempotent", async () => {
    const stub = getCounterStub("basic-3");

    await stub.spawn({
      actorType: "counter",
      actorId: "basic-3",
      caller: clientCaller,
      input: { initialCount: 10 },
    });

    // Second spawn with different input — should be ignored
    await stub.spawn({
      actorType: "counter",
      actorId: "basic-3",
      caller: clientCaller,
      input: { initialCount: 999 },
    });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(10);
  });
});

describe("createDurableActor: transitions", () => {
  it("INCREMENT increases count", async () => {
    const stub = getCounterStub("trans-1");
    await stub.spawn({ actorType: "counter", actorId: "trans-1", caller: clientCaller, input: {} });

    stub.send({ type: "INCREMENT", caller: clientCaller });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(1);
    expect(result.snapshot.lastUpdatedBy).toBe("user-1");
  });

  it("DECREMENT decreases count", async () => {
    const stub = getCounterStub("trans-2");
    await stub.spawn({ actorType: "counter", actorId: "trans-2", caller: clientCaller, input: { initialCount: 5 } });

    stub.send({ type: "DECREMENT", caller: clientCaller });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(4);
  });

  it("SET sets count to specific value", async () => {
    const stub = getCounterStub("trans-3");
    await stub.spawn({ actorType: "counter", actorId: "trans-3", caller: clientCaller, input: {} });

    stub.send({ type: "SET", value: 100, caller: clientCaller });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(100);
  });

  it("multiple transitions compose correctly", async () => {
    const stub = getCounterStub("trans-4");
    await stub.spawn({ actorType: "counter", actorId: "trans-4", caller: clientCaller, input: {} });

    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "DECREMENT", caller: clientCaller });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.count).toBe(2);
  });
});

describe("createDurableActor: caller-scoped views (getView)", () => {
  it("tracks per-caller access counts", async () => {
    const stub = getCounterStub("view-1");
    await stub.spawn({ actorType: "counter", actorId: "view-1", caller: clientCaller, input: {} });

    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "INCREMENT", caller: clientCaller });

    const result = await stub.getSnapshot(clientCaller);
    expect(result.snapshot.myAccessCount).toBe(2);
  });

  it("different callers see their own access counts", async () => {
    const user2 = { id: "user-2", type: "client" as const };
    const stub = getCounterStub("view-2");
    await stub.spawn({ actorType: "counter", actorId: "view-2", caller: clientCaller, input: {} });

    // user-1 increments 3 times
    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "INCREMENT", caller: clientCaller });

    // user-2 increments once
    stub.send({ type: "INCREMENT", caller: user2 });

    // Both see same count, different access counts
    const result1 = await stub.getSnapshot(clientCaller);
    expect(result1.snapshot.count).toBe(4);
    expect(result1.snapshot.myAccessCount).toBe(3);

    const result2 = await stub.getSnapshot(user2);
    expect(result2.snapshot.count).toBe(4);
    expect(result2.snapshot.myAccessCount).toBe(1);
  });

  it("checksum is consistent for same state", async () => {
    const stub = getCounterStub("view-3");
    await stub.spawn({ actorType: "counter", actorId: "view-3", caller: clientCaller, input: {} });

    const r1 = await stub.getSnapshot(clientCaller);
    const r2 = await stub.getSnapshot(clientCaller);
    expect(r1.checksum).toBe(r2.checksum);
  });

  it("checksum changes when state changes", async () => {
    const stub = getCounterStub("view-4");
    await stub.spawn({ actorType: "counter", actorId: "view-4", caller: clientCaller, input: {} });

    const before = await stub.getSnapshot(clientCaller);
    stub.send({ type: "INCREMENT", caller: clientCaller });
    const after = await stub.getSnapshot(clientCaller);

    expect(before.checksum).not.toBe(after.checksum);
  });
});

describe("createDurableActor: authorization via caller type", () => {
  it("RESET only works for service callers", async () => {
    const stub = getCounterStub("auth-1");
    await stub.spawn({ actorType: "counter", actorId: "auth-1", caller: clientCaller, input: { initialCount: 10 } });

    // Client tries to reset — should be ignored
    stub.send({ type: "RESET", caller: clientCaller });
    const afterClient = await stub.getSnapshot(clientCaller);
    expect(afterClient.snapshot.count).toBe(10);

    // Service resets — should work
    stub.send({ type: "RESET", caller: serviceCaller });
    const afterService = await stub.getSnapshot(clientCaller);
    expect(afterService.snapshot.count).toBe(0);
  });
});

describe("createDurableActor: persistence", () => {
  it("state persists across getSnapshot calls", async () => {
    const stub = getCounterStub("persist-1");
    await stub.spawn({ actorType: "counter", actorId: "persist-1", caller: clientCaller, input: {} });

    stub.send({ type: "INCREMENT", caller: clientCaller });
    stub.send({ type: "INCREMENT", caller: clientCaller });

    // Multiple reads should return consistent state
    const r1 = await stub.getSnapshot(clientCaller);
    const r2 = await stub.getSnapshot(clientCaller);
    expect(r1.snapshot.count).toBe(2);
    expect(r2.snapshot.count).toBe(2);
    expect(r1.checksum).toBe(r2.checksum);
  });
});
