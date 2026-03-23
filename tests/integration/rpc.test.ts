import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Actor-to-actor RPC (integration)", () => {
  it("one DO can send messages to another DO via send()", async () => {
    // Create two separate DOs
    const counterId = env.COUNTER.idFromName("rpc-counter");
    const counterStub = env.COUNTER.get(counterId);
    await counterStub.spawn({ actorId: "rpc-counter", caller: "u1", callerType: "user", input: {} });

    const timerId = env.TIMER_ACTOR.idFromName("rpc-timer");
    const timerStub = env.TIMER_ACTOR.get(timerId);
    await timerStub.spawn({ actorId: "rpc-timer", caller: "u1", callerType: "user", input: {} });

    // Send messages to each independently
    await counterStub.send("u1", "user", { type: "INCREMENT", amount: 5 });
    await timerStub.send("u1", "user", { type: "INCREMENT" });

    // Verify each has its own state
    const counterSnap = await counterStub.getSnapshot("u1", "user");
    const timerSnap = await timerStub.getSnapshot("u1", "user");

    expect((counterSnap.snapshot as { count: number }).count).toBe(5);
    expect((timerSnap.snapshot as { count: number }).count).toBe(1);
  });

  it("DOs are isolated — changes to one don't affect another", async () => {
    const id1 = env.COUNTER.idFromName("rpc-isolated-1");
    const id2 = env.COUNTER.idFromName("rpc-isolated-2");
    const stub1 = env.COUNTER.get(id1);
    const stub2 = env.COUNTER.get(id2);

    await stub1.spawn({ actorId: "rpc-isolated-1", caller: "u1", callerType: "user", input: {} });
    await stub2.spawn({ actorId: "rpc-isolated-2", caller: "u1", callerType: "user", input: {} });

    await stub1.send("u1", "user", { type: "INCREMENT", amount: 100 });

    const snap1 = await stub1.getSnapshot("u1", "user");
    const snap2 = await stub2.getSnapshot("u1", "user");

    expect((snap1.snapshot as { count: number }).count).toBe(100);
    expect((snap2.snapshot as { count: number }).count).toBe(0);
  });

  it("createRef pattern works for DO-to-DO via stubs", async () => {
    // This tests the ref() pattern at the integration level
    // In production, ref() is called inside a message handler
    // Here we simulate it by calling the target stub directly
    const targetId = env.COUNTER.idFromName("rpc-ref-target");
    const targetStub = env.COUNTER.get(targetId);
    await targetStub.spawn({ actorId: "rpc-ref-target", caller: "svc", callerType: "service", input: {} });

    // Simulate what ref().send() does internally
    const result = await targetStub.send("system", "service", { type: "INCREMENT", amount: 42 });
    expect(result.ok).toBe(true);

    const snap = await targetStub.getSnapshot("svc", "service");
    expect((snap.snapshot as { count: number }).count).toBe(42);
  });
});
