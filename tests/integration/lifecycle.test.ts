import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createAccessToken } from "../../packages/actor-kit/src/auth/auth";

describe("Counter DO lifecycle", () => {
  const SECRET = "test-secret-for-integration-tests-only";

  it("spawns a counter and returns snapshot", async () => {
    const id = env.COUNTER.idFromName("test-spawn");
    const stub = env.COUNTER.get(id);

    // Spawn the actor
    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    // Get snapshot
    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 0, lastCaller: "" });
    expect(result.role).toBe("user");
    expect(typeof result.checksum).toBe("string");
  });

  it("spawn is idempotent", async () => {
    const id = env.COUNTER.idFromName("test-idempotent");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });
    await stub.spawn({ caller: "user-1", callerType: "user", input: {} }); // second call is no-op

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 0, lastCaller: "" });
  });

  it("sends messages and updates state", async () => {
    const id = env.COUNTER.idFromName("test-send");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    const sendResult = await stub.send("user-1", "user", { type: "INCREMENT", amount: 5 });
    expect(sendResult.ok).toBe(true);

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 5, lastCaller: "user-1" });
  });

  it("rejects unauthorized messages", async () => {
    const id = env.COUNTER.idFromName("test-auth");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    // Regular user trying to RESET (admin-only)
    const sendResult = await stub.send("user-1", "user", { type: "RESET" });
    expect(sendResult.ok).toBe(false);
    expect(sendResult.error).toBe("message_not_found");
  });

  it("admin can reset", async () => {
    const id = env.COUNTER.idFromName("test-admin-reset");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 10 });

    // Service caller gets admin role
    const resetResult = await stub.send("service-1", "service", { type: "RESET" });
    expect(resetResult.ok).toBe(true);

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 0, lastCaller: "" });
  });

  it("rejects invalid payload (Zod validation)", async () => {
    const id = env.COUNTER.idFromName("test-validation");
    const stub = env.COUNTER.get(id);

    await stub.spawn({ caller: "user-1", callerType: "user", input: {} });

    // Negative amount (schema requires positive)
    const sendResult = await stub.send("user-1", "user", { type: "INCREMENT", amount: -5 });
    expect(sendResult.ok).toBe(false);
    expect(sendResult.error).toBe("validation_failed");
  });

  it("persists state across DO restarts", async () => {
    const id = env.COUNTER.idFromName("test-persist");
    const stub1 = env.COUNTER.get(id);

    await stub1.spawn({ caller: "user-1", callerType: "user", input: {} });
    await stub1.send("user-1", "user", { type: "INCREMENT", amount: 42 });

    // Get a new stub (simulates DO restart)
    const stub2 = env.COUNTER.get(id);
    const result = await stub2.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 42, lastCaller: "user-1" });
  });
});
