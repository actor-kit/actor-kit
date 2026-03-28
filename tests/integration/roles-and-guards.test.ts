import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Roles and authorization (integration)", () => {
  it("user role can INCREMENT but not RESET (guard rejects)", async () => {
    const { stub, actorId } = getStub("role-user-1");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const incResult = await stub.send("user-1", "user", { type: "INCREMENT", amount: 5 });
    expect(incResult.ok).toBe(true);

    const resetResult = await stub.send("user-1", "user", { type: "RESET" });
    expect(resetResult.ok).toBe(false);
    expect(resetResult.error).toBe("guard_failed");
  });

  it("service caller gets admin role with full access", async () => {
    const { stub, actorId } = getStub("role-admin-1");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    // Admin can INCREMENT, DECREMENT, RESET, NOTIFY
    const inc = await stub.send("svc-1", "service", { type: "INCREMENT", amount: 3 });
    expect(inc.ok).toBe(true);

    const dec = await stub.send("svc-1", "service", { type: "DECREMENT", amount: 1 });
    expect(dec.ok).toBe(true);

    const snapshot = await stub.getSnapshot("svc-1", "service");
    expect((snapshot.snapshot as { count: number }).count).toBe(2);

    const reset = await stub.send("svc-1", "service", { type: "RESET" });
    expect(reset.ok).toBe(true);

    const after = await stub.getSnapshot("svc-1", "service");
    expect((after.snapshot as { count: number }).count).toBe(0);
  });

  it("role re-evaluates on every message", async () => {
    const { stub, actorId } = getStub("role-reeval-1");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    // User sends INCREMENT
    const r1 = await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
    expect(r1.ok).toBe(true);

    // Same user, different callerType = different role
    const r2 = await stub.send("user-1", "service", { type: "RESET" });
    expect(r2.ok).toBe(true);
  });
});

describe("Payload validation (integration)", () => {
  it("rejects negative amount (schema: positive integer)", async () => {
    const { stub, actorId } = getStub("validation-neg");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const result = await stub.send("user-1", "user", { type: "INCREMENT", amount: -5 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("validation_failed");
  });

  it("rejects float amount (schema: integer)", async () => {
    const { stub, actorId } = getStub("validation-float");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const result = await stub.send("user-1", "user", { type: "INCREMENT", amount: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("validation_failed");
  });

  it("rejects missing required field", async () => {
    const { stub, actorId } = getStub("validation-missing");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const result = await stub.send("user-1", "user", { type: "INCREMENT" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("validation_failed");
  });

  it("rejects unknown message type", async () => {
    const { stub, actorId } = getStub("validation-unknown");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const result = await stub.send("user-1", "user", { type: "NONEXISTENT" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("message_not_found");
  });
});

describe("Payload guards (integration)", () => {
  it("guard rejects based on state + payload", async () => {
    const { stub, actorId } = getStub("guard-payload-1");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    // Add 90 — within limit (0 + 90 <= 100)
    const r1 = await stub.send("user-1", "user", { type: "GUARDED_ADD", amount: 90 });
    expect(r1.ok).toBe(true);

    // Add 20 — exceeds limit (90 + 20 > 100)
    const r2 = await stub.send("user-1", "user", { type: "GUARDED_ADD", amount: 20 });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("guard_failed");

    // Add 10 — exactly at limit (90 + 10 = 100)
    const r3 = await stub.send("user-1", "user", { type: "GUARDED_ADD", amount: 10 });
    expect(r3.ok).toBe(true);

    const snap = await stub.getSnapshot("user-1", "user");
    expect((snap.snapshot as { count: number }).count).toBe(100);
  });

  it("open messages (no guard) are available to all roles", async () => {
    const { stub, actorId } = getStub("guard-open-1");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    // Both user and admin can INCREMENT (no guard)
    const r1 = await stub.send("user-1", "user", { type: "INCREMENT", amount: 1 });
    expect(r1.ok).toBe(true);

    const r2 = await stub.send("svc-1", "service", { type: "INCREMENT", amount: 2 });
    expect(r2.ok).toBe(true);

    const snap = await stub.getSnapshot("user-1", "user");
    expect((snap.snapshot as { count: number }).count).toBe(3);
  });
});

describe("Views per role (integration)", () => {
  it("user and admin see same view shape but different roles", async () => {
    const { stub, actorId } = getStub("views-1");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 10 });

    const userView = await stub.getSnapshot("user-1", "user");
    const adminView = await stub.getSnapshot("admin-1", "service");

    expect(userView.role).toBe("user");
    expect(adminView.role).toBe("admin");
    expect((userView.snapshot as { count: number }).count).toBe(10);
    expect((adminView.snapshot as { count: number }).count).toBe(10);
  });
});
