import { createRef } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("createRef — kill survivors", () => {
  it("throws when namespace not found in env", () => {
    expect(() => createRef({}, "MISSING", "id-1")).toThrow(/not found/);
  });

  it("getSnapshot delegates to stub", async () => {
    let capturedArgs: unknown[] = [];
    const fakeEnv = {
      ZONE: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => ({
          getSnapshot: async (caller: string, callerType: string) => {
            capturedArgs = [caller, callerType];
            return { snapshot: { count: 42 }, role: "user", checksum: "abc" };
          },
        }),
      },
    };

    const ref = createRef(fakeEnv, "ZONE", "z1");
    const result = await ref.getSnapshot("alice", "user");
    expect(result.snapshot).toEqual({ count: 42 });
    expect(capturedArgs).toEqual(["alice", "user"]);
  });

  it("send returns error when stub.send is missing", async () => {
    const fakeEnv = {
      ZONE: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => ({}),
      },
    };

    const ref = createRef(fakeEnv, "ZONE", "z1");
    const result = await ref.send("alice", "user", { type: "TEST" });
    expect(result.ok).toBe(false);
  });

  it("getSnapshot throws when stub.getSnapshot is missing", async () => {
    const fakeEnv = {
      ZONE: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => ({}),
      },
    };

    const ref = createRef(fakeEnv, "ZONE", "z1");
    await expect(ref.getSnapshot("alice", "user")).rejects.toThrow();
  });

  it("spawn is a no-op when stub.spawn is missing", async () => {
    const fakeEnv = {
      ZONE: {
        idFromName: () => ({ toString: () => "id" }),
        get: () => ({}),
      },
    };

    const ref = createRef(fakeEnv, "ZONE", "z1");
    // Should not throw
    await ref.spawn({ caller: "alice", callerType: "user", input: {} });
  });
});
