/**
 * Integration tests for adapter parity — defineLogic, fromRedux, fromXStateStore.
 *
 * Uses @cloudflare/vitest-pool-workers to run inside Workers runtime
 * with real DO bindings and isolated storage per test.
 *
 * All three adapters implement the same counter behavior; the same test
 * suite runs against each adapter via describe.each.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DurableActorMethods } from "../../../packages/core/src/types";
import type { PlainCounter, ReduxCounter, StoreCounter } from "./src/index";

// ============================================================================
// Helpers
// ============================================================================

type CounterView = {
  count: number;
  myAccessCount: number;
};

type CounterDO = DurableActorMethods<CounterView>;

/**
 * Type-safe stub accessor for adapter DOs.
 */
function getStub(
  namespace: DurableObjectNamespace<CounterDO>,
  name: string
): CounterDO {
  return namespace.getByName(name) as unknown as CounterDO;
}

type AdapterEntry = {
  name: string;
  binding: DurableObjectNamespace<CounterDO>;
  actorType: string;
};

function getAdapters(): AdapterEntry[] {
  return [
    {
      name: "defineLogic (PlainCounter)",
      binding: env.PLAIN_COUNTER as unknown as DurableObjectNamespace<CounterDO>,
      actorType: "plain-counter",
    },
    {
      name: "fromRedux (ReduxCounter)",
      binding: env.REDUX_COUNTER as unknown as DurableObjectNamespace<CounterDO>,
      actorType: "redux-counter",
    },
    {
      name: "fromXStateStore (StoreCounter)",
      binding: env.STORE_COUNTER as unknown as DurableObjectNamespace<CounterDO>,
      actorType: "store-counter",
    },
  ];
}

// ============================================================================
// Parameterized tests
// ============================================================================

describe.each(getAdapters())(
  "Adapter: $name",
  ({ binding, actorType }) => {
    it("spawns with default state", async () => {
      const id = `${actorType}-default-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.count).toBe(0);
    });

    it("spawns with initial count from input", async () => {
      const id = `${actorType}-init-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: { initialCount: 42 },
      });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.count).toBe(42);
    });

    it("increments the counter", async () => {
      const id = `${actorType}-inc-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.count).toBe(2);
    });

    it("decrements the counter", async () => {
      const id = `${actorType}-dec-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: { initialCount: 5 },
      });

      stub.send({ type: "DECREMENT", caller: { id: "user-1", type: "client" } });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.count).toBe(4);
    });

    it("increments and decrements together", async () => {
      const id = `${actorType}-mixed-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "DECREMENT", caller: { id: "user-1", type: "client" } });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.count).toBe(2);
    });

    it("service caller can reset the counter", async () => {
      const id = `${actorType}-svc-reset-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "svc-1", type: "service" },
        input: {},
      });

      stub.send({ type: "INCREMENT", caller: { id: "svc-1", type: "service" } });
      stub.send({ type: "INCREMENT", caller: { id: "svc-1", type: "service" } });
      stub.send({ type: "RESET", caller: { id: "svc-1", type: "service" } });

      const result = await stub.getSnapshot({ id: "svc-1", type: "service" });

      expect(result.snapshot.count).toBe(0);
    });

    it("client caller cannot reset the counter", async () => {
      const id = `${actorType}-client-reset-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "RESET", caller: { id: "user-1", type: "client" } });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.count).toBe(2);
    });

    it("tracks per-caller access count via onConnect", async () => {
      const id = `${actorType}-access-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      // getSnapshot should reflect access count from the onConnect triggered during spawn
      // Note: spawn itself doesn't trigger onConnect — onConnect is triggered by WebSocket connections.
      // Via RPC, myAccessCount starts at 0.
      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.snapshot.myAccessCount).toBe(0);
    });

    it("different callers see their own access count", async () => {
      const id = `${actorType}-multi-caller-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      // Both callers increment the same counter
      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });
      stub.send({ type: "INCREMENT", caller: { id: "user-2", type: "client" } });

      // Both see the same count
      const result1 = await stub.getSnapshot({ id: "user-1", type: "client" });
      const result2 = await stub.getSnapshot({ id: "user-2", type: "client" });

      expect(result1.snapshot.count).toBe(2);
      expect(result2.snapshot.count).toBe(2);

      // But each has their own access count (0 via RPC — onConnect only fires on WebSocket)
      expect(result1.snapshot.myAccessCount).toBe(0);
      expect(result2.snapshot.myAccessCount).toBe(0);
    });

    it("returns a checksum with the snapshot", async () => {
      const id = `${actorType}-checksum-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      const result = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(result.checksum).toBeDefined();
      expect(typeof result.checksum).toBe("string");
      expect(result.checksum.length).toBeGreaterThan(0);
    });

    it("checksum changes after state mutation", async () => {
      const id = `${actorType}-checksum-change-${Date.now()}`;
      const stub = getStub(binding, id);

      stub.spawn({
        actorType,
        actorId: id,
        caller: { id: "user-1", type: "client" },
        input: {},
      });

      const before = await stub.getSnapshot({ id: "user-1", type: "client" });

      stub.send({ type: "INCREMENT", caller: { id: "user-1", type: "client" } });

      const after = await stub.getSnapshot({ id: "user-1", type: "client" });

      expect(before.checksum).not.toBe(after.checksum);
    });
  }
);
