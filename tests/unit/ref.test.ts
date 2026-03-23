import { describe, expect, it } from "vitest";
import { createRef } from "../../packages/actor-kit/src/core/ref";

describe("createRef()", () => {
  it("creates a ref with actor type and id", () => {
    const fakeEnv = {
      ZONE: {
        idFromName: (name: string) => ({ toString: () => `id-${name}` }),
        get: (id: { toString: () => string }) => ({
          id: id.toString(),
          spawn: async () => {},
          send: async () => ({ ok: true }),
          getSnapshot: async () => ({ snapshot: {} }),
        }),
      },
    };

    const zoneRef = createRef(fakeEnv, "ZONE", "forest-north");
    expect(zoneRef.actorType).toBe("ZONE");
    expect(zoneRef.actorId).toBe("forest-north");
  });

  it("call() invokes a method on the target stub", async () => {
    const calls: { method: string; payload: unknown }[] = [];
    const fakeEnv = {
      ZONE: {
        idFromName: (name: string) => ({ toString: () => `id-${name}` }),
        get: () => ({
          send: async (_caller: string, _type: string, event: unknown) => {
            calls.push({ method: "send", payload: event });
            return { ok: true };
          },
        }),
      },
    };

    const zoneRef = createRef(fakeEnv, "ZONE", "forest-north");
    await zoneRef.send("service-caller", "service", { type: "ACCEPT_TRANSFER", data: "test" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ type: "ACCEPT_TRANSFER", data: "test" });
  });

  it("spawn() calls spawn on the target stub", async () => {
    let spawnCalled = false;
    const fakeEnv = {
      COUNTER: {
        idFromName: () => ({ toString: () => "id-1" }),
        get: () => ({
          spawn: async (_input: unknown) => {
            spawnCalled = true;
          },
        }),
      },
    };

    const counterRef = createRef(fakeEnv, "COUNTER", "counter-1");
    await counterRef.spawn({ actorId: "counter-1", caller: "service", callerType: "service", input: {} });

    expect(spawnCalled).toBe(true);
  });
});
