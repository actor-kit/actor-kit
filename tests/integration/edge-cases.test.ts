import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Counter DO edge cases", () => {
  it("send on unspawned actor returns error", async () => {
    const { stub } = getStub("edge-unspawned-send");

    const result = await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not initialized/i);
  });

  it("multiple rapid sends maintain consistency", async () => {
    const { stub, actorId } = getStub("edge-rapid");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    // Send 10 increments rapidly
    const promises = Array.from({ length: 10 }, (_, _i) =>
      stub.send("user-1", "user", { type: "INCREMENT", amount: 1 }),
    );
    const results = await Promise.all(promises);

    // All should succeed (DOs are single-threaded, so they queue)
    expect(results.every((r) => r.ok)).toBe(true);

    const snapshot = await stub.getSnapshot("user-1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(10);
  });

  it("different callers get role-appropriate responses", async () => {
    const { stub, actorId } = getStub("edge-roles");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 5 });

    // User sees user view
    const userSnapshot = await stub.getSnapshot("user-1", "user");
    expect(userSnapshot.role).toBe("user");

    // Service sees admin view
    const adminSnapshot = await stub.getSnapshot("service-1", "service");
    expect(adminSnapshot.role).toBe("admin");

    // Both see the same count
    expect((userSnapshot.snapshot as { count: number }).count).toBe(5);
    expect((adminSnapshot.snapshot as { count: number }).count).toBe(5);
  });
});
