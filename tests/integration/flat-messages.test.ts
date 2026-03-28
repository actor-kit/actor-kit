import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.FLAT_COUNTER.idFromName(name);
  return { stub: env.FLAT_COUNTER.get(id), actorId: name };
}

describe("Flat messages with role guards (integration)", () => {
  it("all roles can send messages without guards", async () => {
    const { stub, actorId } = getStub("flat-open-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // INCREMENT has no guard — any role can use it
    const result = await stub.send("u1", "user", { type: "INCREMENT", amount: 5 });
    expect(result.ok).toBe(true);

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(5);
  });

  it("guard with ctx.role rejects unauthorized role", async () => {
    const { stub, actorId } = getStub("flat-role-guard-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // User tries ADMIN_RESET — guard checks ctx.role === "admin"
    const result = await stub.send("u1", "user", { type: "ADMIN_RESET" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("guard_failed");
  });

  it("guard with ctx.role allows authorized role", async () => {
    const { stub, actorId } = getStub("flat-role-guard-2");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Increment first
    await stub.send("u1", "user", { type: "INCREMENT", amount: 10 });

    // Admin (service callerType) can ADMIN_RESET
    const result = await stub.send("svc1", "service", { type: "ADMIN_RESET" });
    expect(result.ok).toBe(true);

    const snapshot = await stub.getSnapshot("svc1", "service");
    expect((snapshot.snapshot as { count: number }).count).toBe(0);
  });

  it("guard with payload validates content", async () => {
    const { stub, actorId } = getStub("flat-payload-guard-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Add 90 first
    await stub.send("u1", "user", { type: "INCREMENT", amount: 90 });

    // LIMITED_ADD guard checks state.count + amount <= 100
    // 90 + 5 = 95 ≤ 100 → allowed
    const result1 = await stub.send("u1", "user", { type: "LIMITED_ADD", amount: 5 });
    expect(result1.ok).toBe(true);

    // 95 + 10 = 105 > 100 → rejected by guard
    const result2 = await stub.send("u1", "user", { type: "LIMITED_ADD", amount: 10 });
    expect(result2.ok).toBe(false);
    expect(result2.error).toBe("guard_failed");
  });

  it("flat messages are available to all roles (no role-scoping)", async () => {
    const { stub, actorId } = getStub("flat-all-roles-1");
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // User can send LIMITED_ADD (no role restriction, only payload guard)
    const result = await stub.send("u1", "user", { type: "LIMITED_ADD", amount: 5 });
    expect(result.ok).toBe(true);

    // Admin can also send LIMITED_ADD
    const result2 = await stub.send("svc1", "service", { type: "LIMITED_ADD", amount: 3 });
    expect(result2.ok).toBe(true);

    const snapshot = await stub.getSnapshot("svc1", "service");
    expect((snapshot.snapshot as { count: number }).count).toBe(8);
  });
});
