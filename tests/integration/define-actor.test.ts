import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER_V3.idFromName(name);
  return { stub: env.COUNTER_V3.get(id), actorId: name };
}

describe("createActorClass() integration", () => {
  it("produces a DO that can spawn and accept messages", async () => {
    const { stub, actorId } = getStub("v3-basic");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 5 });

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(5);
  });

  it("state persists across stub recreation", async () => {
    const { stub, actorId } = getStub("v3-persist");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 42 });

    const stub2 = env.COUNTER_V3.get(env.COUNTER_V3.idFromName("v3-persist"));
    const snapshot = await stub2.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(42);
  });

  it("role-based message authorization works", async () => {
    const { stub, actorId } = getStub("v3-roles");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // User can INCREMENT
    const result = await stub.send("u1", "user", { type: "INCREMENT", amount: 1 });
    expect(result.ok).toBe(true);

    // User cannot DECREMENT (admin only)
    const result2 = await stub.send("u1", "user", { type: "DECREMENT", amount: 1 });
    expect(result2.ok).toBe(false);
  });

  it("view computation works for different roles", async () => {
    const { stub, actorId } = getStub("v3-views");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 10 });

    const snapshot = await stub.getSnapshot("u1", "user");
    expect(snapshot.role).toBe("user");
    expect((snapshot.snapshot as { count: number }).count).toBe(10);
  });
});
