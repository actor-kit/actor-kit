import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Outbox side effects (integration)", () => {
  it("emit() in handler does not affect state", async () => {
    const { stub, actorId } = getStub("outbox-effect-1");
    await stub.spawn({ actorId, caller: "svc-1", callerType: "service", input: {} });

    // NOTIFY calls ctx.emit() but doesn't change count
    await stub.send("svc-1", "service", { type: "INCREMENT", amount: 5 });
    await stub.send("svc-1", "service", { type: "NOTIFY" });

    const snapshot = await stub.getSnapshot("svc-1", "service");
    expect((snapshot.snapshot as { count: number }).count).toBe(5);
  });

  it("multiple sends with emit() maintain correct state", async () => {
    const { stub, actorId } = getStub("outbox-effect-2");
    await stub.spawn({ actorId, caller: "svc-1", callerType: "service", input: {} });

    // Interleave INCREMENT and NOTIFY
    await stub.send("svc-1", "service", { type: "INCREMENT", amount: 1 });
    await stub.send("svc-1", "service", { type: "NOTIFY" });
    await stub.send("svc-1", "service", { type: "INCREMENT", amount: 2 });
    await stub.send("svc-1", "service", { type: "NOTIFY" });
    await stub.send("svc-1", "service", { type: "INCREMENT", amount: 3 });

    const snapshot = await stub.getSnapshot("svc-1", "service");
    expect((snapshot.snapshot as { count: number }).count).toBe(6);
  });
});
