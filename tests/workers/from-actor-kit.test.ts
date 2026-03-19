/**
 * Integration tests for fromActorKit — DO-to-DO communication.
 *
 * Uses @cloudflare/vitest-pool-workers to run inside Workers runtime
 * with real DO bindings and isolated storage per test.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActorServerMethods, AnyActorKitStateMachine } from "../../src/types";
import type { CounterMachine, AggregatorMachine } from "./src/index";

/**
 * Type-safe stub accessor that exposes actor-kit RPC methods.
 * DurableObjectStub from getByName() doesn't expose our RPC methods,
 * so we type it through ActorServerMethods<TMachine>.
 */
function getActorStub<TMachine extends AnyActorKitStateMachine>(
  namespace: { getByName(name: string): unknown },
  name: string
): ActorServerMethods<TMachine> {
  return namespace.getByName(name) as ActorServerMethods<TMachine>;
}

describe("fromActorKit: DO-to-DO via Workers pool", () => {
  it("counter DO can be spawned and incremented via RPC", async () => {
    const stub = getActorStub<CounterMachine>(env.COUNTER, "rpc-test-1");

    stub.spawn({
      actorType: "counter",
      actorId: "rpc-test-1",
      caller: { id: "test-user", type: "client" },
      input: {},
    });

    stub.send({ type: "INCREMENT" });

    const result = await stub.getSnapshot({
      id: "test-user",
      type: "client",
    });

    expect(result.snapshot.public.count).toBe(1);
  });

  it("aggregator spawns and sets up counter connection", async () => {
    const stub = getActorStub<AggregatorMachine>(env.AGGREGATOR, "agg-test-1");

    stub.spawn({
      actorType: "aggregator",
      actorId: "agg-test-1",
      caller: { id: "test-user", type: "client" },
      input: {},
    });

    // Give fromActorKit time to connect and receive initial snapshot
    await new Promise((r) => setTimeout(r, 3000));

    const result = await stub.getSnapshot({
      id: "test-user",
      type: "client",
    });

    expect(result.snapshot.public.counterId).toBe("counter-for-agg-test-1");
    expect(result.snapshot.public.counterCount).toBe(0);
  });

  it("INCREMENT_COUNTER flows through aggregator to counter and back", async () => {
    const stub = getActorStub<AggregatorMachine>(env.AGGREGATOR, "agg-test-2");

    stub.spawn({
      actorType: "aggregator",
      actorId: "agg-test-2",
      caller: { id: "test-user", type: "client" },
      input: {},
    });

    // Wait for connection
    await new Promise((r) => setTimeout(r, 3000));

    stub.send({ type: "INCREMENT_COUNTER" });

    // Wait for round-trip: aggregator → counter → snapshot patch → aggregator
    await new Promise((r) => setTimeout(r, 3000));

    const result = await stub.getSnapshot({
      id: "test-user",
      type: "client",
    });

    expect(result.snapshot.public.counterCount).toBe(1);
  });
});
