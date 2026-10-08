import { createRef } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

/** One recorded call on a fake namespace. */
type Call = { method: "idFromName"; name: string } | { method: "get"; id: string; options: unknown };

function fakeNamespace(stub: object = {}) {
  const calls: Call[] = [];
  const namespace = {
    idFromName(name: string) {
      calls.push({ method: "idFromName", name });
      return { toString: () => `id:${name}` };
    },
    get(id: { toString(): string }, options?: { locationHint?: string }) {
      calls.push({ method: "get", id: id.toString(), options });
      return stub;
    },
  };
  return { namespace, calls };
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("threw a non-Error");
  }
  throw new Error("did not throw");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("rejected with a non-Error");
  }
  throw new Error("did not reject");
}

/** Calls createRef the way an untyped (JavaScript) caller would. */
function untypedCreateRef(...args: unknown[]): unknown {
  return Reflect.apply(createRef, undefined, args);
}

const Room = { name: "chat-room", def: { messages: {} } };

describe("createRef legacy dispatch — env objects that are not contracts", () => {
  it("treats a function env that has name and def as an env, not a contract", () => {
    const { namespace, calls } = fakeNamespace();
    const env = Object.assign(() => undefined, { def: {}, ZONE: namespace });
    const ref: unknown = untypedCreateRef(env, "ZONE", "z-1");
    expect(ref).toMatchObject({ actorType: "ZONE", actorId: "z-1" });
    expect(calls).toEqual([
      { method: "idFromName", name: "z-1" },
      { method: "get", id: "id:z-1", options: undefined },
    ]);
  });

  it("treats an env without a name as an env even when it has def", () => {
    const { namespace } = fakeNamespace();
    const ref = createRef({ def: {}, ZONE: namespace }, "ZONE", "z-2");
    expect(ref.actorType).toBe("ZONE");
  });

  it("treats an env whose name is not a string as an env", () => {
    const { namespace } = fakeNamespace();
    const ref = createRef({ name: 5, def: {}, ZONE: namespace }, "ZONE", "z-3");
    expect(ref.actorType).toBe("ZONE");
  });

  it("treats an env with a string name but no def as an env", () => {
    const { namespace } = fakeNamespace();
    const ref = createRef({ name: "prod", ZONE: namespace }, "ZONE", "z-4");
    expect(ref.actorType).toBe("ZONE");
  });

  it("reads a binding off a null env as plain property access", () => {
    const error = thrown(() => untypedCreateRef(null, "ZONE", "z-5"));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("Cannot read properties of null (reading 'ZONE')");
  });
});

describe("createRef namespace validation", () => {
  const notNamespaces: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "ZONE"],
    ["an object without idFromName", { get: () => ({}) }],
    ["an object whose idFromName is not a function", { idFromName: 1, get: () => ({}) }],
    ["an object without get", { idFromName: () => ({}) }],
    ["an object whose get is not a function", { idFromName: () => ({}), get: 1 }],
  ];

  for (const [label, value] of notNamespaces) {
    it(`rejects ${label} as a DO namespace`, () => {
      const error = thrown(() => createRef({ ZONE: value }, "ZONE", "z-1"));
      expect(error.message).toBe('DO namespace "ZONE" not found in env');
    });
  }
});

describe("createRef contract overloads", () => {
  it("contract + env + actorId resolves the upper-snake binding", () => {
    const { namespace, calls } = fakeNamespace();
    const ref = createRef(Room, { CHAT_ROOM: namespace }, "room-1");
    expect({ actorType: ref.actorType, actorId: ref.actorId }).toEqual({ actorType: "CHAT_ROOM", actorId: "room-1" });
    expect(calls).toEqual([
      { method: "idFromName", name: "room-1" },
      { method: "get", id: "id:room-1", options: undefined },
    ]);
  });

  it("contract + env + actorId passes the location hint", () => {
    const { namespace, calls } = fakeNamespace();
    createRef(Room, { CHAT_ROOM: namespace }, "room-1", "weur");
    expect(calls[1]).toEqual({ method: "get", id: "id:room-1", options: { locationHint: "weur" } });
  });

  it("contract + env names the missing binding", () => {
    const error = thrown(() => createRef(Room, {}, "room-1"));
    expect(error.message).toBe('DO namespace "CHAT_ROOM" not found in env');
  });

  it("contract + exports + env + actorId passes the location hint", () => {
    const { namespace, calls } = fakeNamespace();
    const ref = createRef(Room, {}, { CHAT_ROOM: namespace }, "room-2", "apac");
    expect({ actorType: ref.actorType, actorId: ref.actorId }).toEqual({ actorType: "chat-room", actorId: "room-2" });
    expect(calls).toEqual([
      { method: "idFromName", name: "room-2" },
      { method: "get", id: "id:room-2", options: { locationHint: "apac" } },
    ]);
  });

  it("contract + exports + env requires a string actorId", () => {
    const error = thrown(() => untypedCreateRef(Room, {}, {}));
    expect(error.message).toBe("createRef(contract, exports, env, actorId): actorId must be a string");
  });

  it("contract + exports names a resolved value that is not a namespace", () => {
    const exports = { ChatRoom: { __actorKitContractName: "chat-room" } };
    const error = thrown(() => createRef(Room, exports, {}, "room-3"));
    expect(error.message).toBe('Resolved namespace for "chat-room" is not a valid DO namespace');
  });

  const badSecondArgs: Array<[string, unknown, unknown]> = [
    ["a string second argument", "CHAT_ROOM", "room-1"],
    ["a string second argument before an env object", "CHAT_ROOM", {}],
    ["an env with a non-string actorId", { CHAT_ROOM: fakeNamespace().namespace }, 5],
  ];
  for (const [label, second, third] of badSecondArgs) {
    it(`rejects ${label}`, () => {
      const error = thrown(() => untypedCreateRef(Room, second, third));
      expect(error.message).toBe("createRef(contract, ...): second argument must be an env or exports object");
    });
  }
});

describe("ActorRef on a stub without methods", () => {
  it("send reports that the stub has no send", async () => {
    const { namespace } = fakeNamespace({});
    const ref = createRef({ ZONE: namespace }, "ZONE", "z-1");
    await expect(ref.send("u", "user", { type: "PING" })).resolves.toEqual({
      ok: false,
      error: "stub.send not available",
    });
  });

  it("getSnapshot rejects with a named error", async () => {
    const { namespace } = fakeNamespace({});
    const ref = createRef({ ZONE: namespace }, "ZONE", "z-1");
    const error = await rejection(ref.getSnapshot("u", "user"));
    expect(error.message).toBe("stub.getSnapshot not available");
  });
});
