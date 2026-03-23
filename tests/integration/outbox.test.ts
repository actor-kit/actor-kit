import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Counter DO outbox", () => {
  it("persists emit() calls to outbox table", async () => {
    const { stub, actorId } = getStub("outbox-test-1");
    await stub.spawn({ actorId, caller: "service-1", callerType: "service", input: {} });
    await stub.send("service-1", "service", { type: "INCREMENT", amount: 5 });

    const result = await stub.send("service-1", "service", { type: "NOTIFY" });
    expect(result.ok).toBe(true);

    const snapshot = await stub.getSnapshot("service-1", "service");
    expect(snapshot.snapshot).toEqual({ count: 5, lastCaller: "service-1" });
  });

  it("state unchanged by fire-and-forget emit", async () => {
    const { stub, actorId } = getStub("outbox-test-2");
    await stub.spawn({ actorId, caller: "service-1", callerType: "service", input: {} });

    const result = await stub.send("service-1", "service", { type: "NOTIFY" });
    expect(result.ok).toBe(true);

    const snapshot = await stub.getSnapshot("service-1", "service");
    expect(snapshot.snapshot).toEqual({ count: 0, lastCaller: "" });
  });
});
