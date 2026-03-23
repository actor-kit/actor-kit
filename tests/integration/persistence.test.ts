import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Persistence (integration)", () => {
  it("state survives across stub recreation", async () => {
    const { stub: stub1, actorId } = getStub("persist-survive");
    await stub1.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub1.send("u1", "user", { type: "INCREMENT", amount: 42 });

    // Simulate DO restart — get a new stub for the same ID
    const stub2 = env.COUNTER.get(env.COUNTER.idFromName("persist-survive"));
    const snapshot = await stub2.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(42);
  });

  it("multiple sequential updates persist correctly", async () => {
    const { stub, actorId } = getStub("persist-multi");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    for (let i = 0; i < 5; i++) {
      await stub.send("u1", "user", { type: "INCREMENT", amount: 1 });
    }

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(5);
  });

  it("lastCaller tracks who made the change", async () => {
    const { stub, actorId } = getStub("persist-caller");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    await stub.send("alice", "user", { type: "INCREMENT", amount: 1 });
    let snapshot = await stub.getSnapshot("alice", "user");
    expect((snapshot.snapshot as { lastCaller: string }).lastCaller).toBe("alice");

    await stub.send("bob", "user", { type: "INCREMENT", amount: 1 });
    snapshot = await stub.getSnapshot("bob", "user");
    expect((snapshot.snapshot as { lastCaller: string }).lastCaller).toBe("bob");
  });

  it("spawn is idempotent — second spawn does not reset state", async () => {
    const { stub, actorId } = getStub("persist-idempotent");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 99 });

    // Second spawn should be a no-op
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(99);
  });

  it("concurrent sends serialize correctly (count = sum)", async () => {
    const { stub, actorId } = getStub("persist-concurrent");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Send 10 increments concurrently
    const promises = Array.from({ length: 10 }, () =>
      stub.send("u1", "user", { type: "INCREMENT", amount: 1 }),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r.ok)).toBe(true);

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(10);
  });
});
