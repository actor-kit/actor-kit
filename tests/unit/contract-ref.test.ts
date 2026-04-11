import { schema, string, uint32, view } from "@actor-kit/core";
import { createRef, defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Test fixtures ---

type CounterState = { count: number; name: string };

const CounterView = schema({ count: uint32, name: string });

const Counter = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, name: "" }),
  roles: {
    user: () => true,
  },
  messages: {
    INCREMENT: message(z.object({ amount: z.number() }), (state: CounterState, { amount }) => ({
      count: state.count + amount,
      name: state.name,
    })),
    RESET: message(z.object({}), (state: CounterState) => ({
      count: 0,
      name: state.name,
    })),
    RENAME: message(z.object({ newName: z.string() }), (state: CounterState, { newName }) => ({
      count: state.count,
      name: newName,
    })),
  },
  views: {
    user: view.shared(CounterView, (state: CounterState) => ({
      count: state.count,
      name: state.name,
    })),
  },
});

// --- Fake DO namespace ---

function fakeEnv(calls: { method: string; args: unknown[] }[] = []) {
  return {
    COUNTER: {
      idFromName: (name: string) => ({ toString: () => `id-${name}` }),
      get: () => ({
        spawn: async (input: unknown) => {
          calls.push({ method: "spawn", args: [input] });
        },
        send: async (caller: string, callerType: string, event: unknown) => {
          calls.push({ method: "send", args: [caller, callerType, event] });
          return { ok: true };
        },
        getSnapshot: async (caller: string, callerType: string) => {
          calls.push({ method: "getSnapshot", args: [caller, callerType] });
          return { snapshot: { count: 42 }, role: "user", checksum: "abc" };
        },
      }),
    },
  };
}

// --- Type inference tests ---

describe("contract-derived ref", () => {
  it("createRef(contract, env, id) infers send event types from flat messages", () => {
    const ref = createRef(Counter, fakeEnv(), "counter-1");

    // Valid events with correct payload types
    ref.send("alice", "user", { type: "INCREMENT", amount: 1 });
    ref.send("alice", "user", { type: "RESET" });
    ref.send("alice", "user", { type: "RENAME", newName: "test" });

    // @ts-expect-error — INVALID is not a valid message name
    ref.send("alice", "user", { type: "INVALID" });
  });

  it("send() requires correct payload fields", () => {
    const ref = createRef(Counter, fakeEnv(), "counter-1");

    // @ts-expect-error — INCREMENT requires amount field
    ref.send("alice", "user", { type: "INCREMENT" });

    // @ts-expect-error — RENAME requires newName field
    ref.send("alice", "user", { type: "RENAME" });
  });

  it("actorType is inferred from contract name", () => {
    const ref = createRef(Counter, fakeEnv(), "counter-1");
    expect(ref.actorType).toBe("COUNTER");
    expect(ref.actorId).toBe("counter-1");
  });

  it("send() delegates to stub with correct args", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const ref = createRef(Counter, fakeEnv(calls), "counter-1");
    await ref.send("alice", "user", { type: "INCREMENT", amount: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("send");
    expect(calls[0]?.args).toEqual(["alice", "user", { type: "INCREMENT", amount: 5 }]);
  });

  it("spawn() delegates to stub", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const ref = createRef(Counter, fakeEnv(calls), "counter-1");
    await ref.spawn({ caller: "alice", callerType: "user", input: {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("spawn");
  });

  it("getSnapshot() delegates to stub", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const ref = createRef(Counter, fakeEnv(calls), "counter-1");
    const result = await ref.getSnapshot("alice", "user");

    expect(result.snapshot).toEqual({ count: 42 });
    expect(result.role).toBe("user");
  });

  it("kebab-case contract name normalizes to UPPER_SNAKE binding", () => {
    const KebabActor = defineActor("my-actor", {
      input: z.object({}),
      init: (): { value: number } => ({ value: 0 }),
      roles: { user: () => true },
      messages: {
        DO_THING: message(z.object({}), (state: { value: number }) => state),
      },
      views: {
        user: view.shared(CounterView, (state: { value: number }) => ({
          count: state.value,
          name: "",
        })),
      },
    });

    const env = {
      MY_ACTOR: {
        idFromName: (name: string) => ({ toString: () => `id-${name}` }),
        get: () => ({
          send: async () => ({ ok: true }),
        }),
      },
    };

    const ref = createRef(KebabActor, env, "test-1");
    expect(ref.actorType).toBe("MY_ACTOR");
  });

  it("legacy createRef(env, actorType, actorId) still works", () => {
    const ref = createRef(fakeEnv(), "COUNTER", "counter-1");
    expect(ref.actorType).toBe("COUNTER");
    expect(ref.actorId).toBe("counter-1");

    // Legacy ref has loose event typing
    ref.send("alice", "user", { type: "ANYTHING", foo: "bar" });
  });
});

// --- ctx.exports overload tests (ADR-012) ---

describe("createRef with exports (ADR-012)", () => {
  function fakeExports() {
    return {
      CounterDO: {
        __actorKitContractName: "counter",
        idFromName: (name: string) => ({ toString: () => `id-${name}` }),
        get: () => ({
          spawn: async () => {},
          send: async () => ({ ok: true }),
          getSnapshot: async () => ({ snapshot: { count: 42 }, role: "user", checksum: "abc" }),
        }),
      },
    };
  }

  it("resolves namespace from exports by contract name", () => {
    const ref = createRef(Counter, fakeExports(), {}, "counter-1");
    expect(ref.actorType).toBe("counter");
    expect(ref.actorId).toBe("counter-1");
  });

  it("send() delegates to stub resolved from exports", async () => {
    const calls: unknown[] = [];
    const exports = {
      CounterDO: {
        __actorKitContractName: "counter",
        idFromName: (name: string) => ({ toString: () => `id-${name}` }),
        get: () => ({
          send: async (caller: string, callerType: string, event: unknown) => {
            calls.push({ caller, callerType, event });
            return { ok: true };
          },
        }),
      },
    };
    const ref = createRef(Counter, exports, {}, "counter-1");
    await ref.send("alice", "user", { type: "INCREMENT", amount: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      caller: "alice",
      callerType: "user",
      event: { type: "INCREMENT", amount: 5 },
    });
  });

  it("falls back to env binding when contract not in exports", () => {
    const ref = createRef(Counter, {}, fakeEnv(), "counter-1");
    expect(ref.actorType).toBe("counter");
    expect(ref.actorId).toBe("counter-1");
  });

  it("throws when not found in exports or env", () => {
    expect(() => createRef(Counter, {}, {}, "counter-1")).toThrow(
      'Actor "counter" not found in ctx.exports or env.COUNTER',
    );
  });
});
