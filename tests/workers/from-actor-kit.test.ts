/**
 * Integration tests for fromActorKit — DO-to-DO communication.
 *
 * Uses @cloudflare/vitest-pool-workers to run inside Workers runtime
 * with real DO bindings and isolated storage per test.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("fromActorKit: DO-to-DO via Workers pool", () => {
  it("counter DO can be spawned and incremented via RPC", async () => {
    const stub = env.COUNTER.getByName("rpc-test-1");

    // Spawn via RPC
    await (stub as any).spawn({
      actorType: "counter",
      actorId: "rpc-test-1",
      caller: { id: "test-user", type: "client" },
      input: {},
    });

    // Increment
    (stub as any).send({
      type: "INCREMENT",
      caller: { id: "test-user", type: "client" },
    });

    // Check state
    const result = await (stub as any).getSnapshot({
      id: "test-user",
      type: "client",
    });

    expect(result.snapshot.public.count).toBe(1);
  });

  it("aggregator spawns and sets up counter connection", async () => {
    const stub = env.AGGREGATOR.getByName("agg-test-1");

    await (stub as any).spawn({
      actorType: "aggregator",
      actorId: "agg-test-1",
      caller: { id: "test-user", type: "client" },
      input: {},
    });

    // Give fromActorKit time to connect and receive initial snapshot
    await new Promise((r) => setTimeout(r, 3000));

    const result = await (stub as any).getSnapshot({
      id: "test-user",
      type: "client",
    });

    expect(result.snapshot.public.counterId).toBe("counter-for-agg-test-1");
    expect(result.snapshot.public.counterCount).toBe(0);
  });

  it("INCREMENT_COUNTER flows through aggregator to counter and back", async () => {
    const stub = env.AGGREGATOR.getByName("agg-test-2");

    await (stub as any).spawn({
      actorType: "aggregator",
      actorId: "agg-test-2",
      caller: { id: "test-user", type: "client" },
      input: {},
    });

    // Wait for connection
    await new Promise((r) => setTimeout(r, 3000));

    // Send INCREMENT_COUNTER — should forward to counter via fromActorKit
    (stub as any).send({
      type: "INCREMENT_COUNTER",
      caller: { id: "test-user", type: "client" },
    });

    // Wait for round-trip: aggregator → counter → snapshot patch → aggregator
    await new Promise((r) => setTimeout(r, 3000));

    const result = await (stub as any).getSnapshot({
      id: "test-user",
      type: "client",
    });

    expect(result.snapshot.public.counterCount).toBe(1);
  });
});
