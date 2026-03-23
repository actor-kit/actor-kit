import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function getStub(name: string) {
  const id = env.COUNTER.idFromName(name);
  return { stub: env.COUNTER.get(id), actorId: name };
}

describe("Counter DO lifecycle", () => {
  it("spawns a counter and returns snapshot", async () => {
    const { stub, actorId } = getStub("test-spawn");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 0, lastCaller: "" });
    expect(result.role).toBe("user");
    expect(typeof result.checksum).toBe("string");
  });

  it("spawn is idempotent", async () => {
    const { stub, actorId } = getStub("test-idempotent");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 0, lastCaller: "" });
  });

  it("sends messages and updates state", async () => {
    const { stub, actorId } = getStub("test-send");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const sendResult = await stub.send("user-1", "user", { type: "INCREMENT", amount: 5 });
    expect(sendResult.ok).toBe(true);

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 5, lastCaller: "user-1" });
  });

  it("rejects unauthorized messages", async () => {
    const { stub, actorId } = getStub("test-auth");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const sendResult = await stub.send("user-1", "user", { type: "RESET" });
    expect(sendResult.ok).toBe(false);
    expect(sendResult.error).toBe("message_not_found");
  });

  it("admin can reset", async () => {
    const { stub, actorId } = getStub("test-admin-reset");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await stub.send("user-1", "user", { type: "INCREMENT", amount: 10 });

    const resetResult = await stub.send("service-1", "service", { type: "RESET" });
    expect(resetResult.ok).toBe(true);

    const result = await stub.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 0, lastCaller: "" });
  });

  it("rejects invalid payload (Zod validation)", async () => {
    const { stub, actorId } = getStub("test-validation");
    await stub.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });

    const sendResult = await stub.send("user-1", "user", { type: "INCREMENT", amount: -5 });
    expect(sendResult.ok).toBe(false);
    expect(sendResult.error).toBe("validation_failed");
  });

  it("persists state across DO restarts", async () => {
    const { stub: stub1, actorId } = getStub("test-persist");
    await stub1.spawn({ actorId, caller: "user-1", callerType: "user", input: {} });
    await stub1.send("user-1", "user", { type: "INCREMENT", amount: 42 });

    const stub2 = env.COUNTER.get(env.COUNTER.idFromName("test-persist"));
    const result = await stub2.getSnapshot("user-1", "user");
    expect(result.snapshot).toEqual({ count: 42, lastCaller: "user-1" });
  });
});
