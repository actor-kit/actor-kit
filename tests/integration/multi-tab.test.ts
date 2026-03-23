import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Multiple callers on same actor (integration)", () => {
  it("different callers get independent snapshots", async () => {
    const { stub, actorId } = getStub("multi-caller-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("alice", "user", { type: "INCREMENT", amount: 5 });

    // Both callers see the same data
    const aliceView = await stub.getSnapshot("alice", "user");
    const bobView = await stub.getSnapshot("bob", "user");

    expect((aliceView.snapshot as { count: number }).count).toBe(5);
    expect((bobView.snapshot as { count: number }).count).toBe(5);
    expect(aliceView.role).toBe("user");
    expect(bobView.role).toBe("user");
  });

  it("different callerTypes see different roles", async () => {
    const { stub, actorId } = getStub("multi-caller-2");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });
    await stub.send("u1", "user", { type: "INCREMENT", amount: 10 });

    const userView = await stub.getSnapshot("u1", "user");
    const adminView = await stub.getSnapshot("svc-1", "service");

    expect(userView.role).toBe("user");
    expect(adminView.role).toBe("admin");

    // Both see the same count
    expect((userView.snapshot as { count: number }).count).toBe(10);
    expect((adminView.snapshot as { count: number }).count).toBe(10);
  });

  it("admin can modify, user sees the result", async () => {
    const { stub, actorId } = getStub("multi-caller-3");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Admin increments
    await stub.send("svc-1", "service", { type: "INCREMENT", amount: 100 });

    // User sees the admin's change
    const userView = await stub.getSnapshot("u1", "user");
    expect((userView.snapshot as { count: number }).count).toBe(100);

    // Admin resets
    await stub.send("svc-1", "service", { type: "RESET" });

    // User sees the reset
    const afterReset = await stub.getSnapshot("u1", "user");
    expect((afterReset.snapshot as { count: number }).count).toBe(0);
  });
});
