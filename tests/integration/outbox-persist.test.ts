import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Outbox persistence (integration)", () => {
  it("emit() in handler persists to outbox and state is unaffected", async () => {
    const { stub, actorId } = getStub("outbox-persist-1");
    await stub.spawn({ actorId, caller: "svc", callerType: "service", input: {} });

    // INCREMENT first so we have some state
    await stub.send("svc", "service", { type: "INCREMENT", amount: 5 });

    // NOTIFY calls ctx.emit() — fire-and-forget
    const result = await stub.send("svc", "service", { type: "NOTIFY" });
    expect(result.ok).toBe(true);

    // State should not be affected by emit()
    const snap = await stub.getSnapshot("svc", "service");
    expect((snap.snapshot as { count: number }).count).toBe(5);
  });

  it("multiple emits in sequence all persist", async () => {
    const { stub, actorId } = getStub("outbox-persist-2");
    await stub.spawn({ actorId, caller: "svc", callerType: "service", input: {} });

    // Send 3 NOTIFYs
    for (let i = 0; i < 3; i++) {
      const result = await stub.send("svc", "service", { type: "NOTIFY" });
      expect(result.ok).toBe(true);
    }

    // State unchanged (NOTIFY is fire-and-forget)
    const snap = await stub.getSnapshot("svc", "service");
    expect((snap.snapshot as { count: number }).count).toBe(0);
  });

  it("emit() and state change in same transition both persist", async () => {
    const { stub, actorId } = getStub("outbox-persist-3");
    await stub.spawn({ actorId, caller: "svc", callerType: "service", input: {} });

    // INCREMENT changes state
    await stub.send("svc", "service", { type: "INCREMENT", amount: 10 });

    // NOTIFY emits but doesn't change state
    await stub.send("svc", "service", { type: "NOTIFY" });

    // Both should have persisted — check state is correct after restart
    const stub2 = env.COUNTER.get(env.COUNTER.idFromName("outbox-persist-3"));
    const snap = await stub2.getSnapshot("svc", "service");
    expect((snap.snapshot as { count: number }).count).toBe(10);
  });
});
