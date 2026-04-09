import { resolveNamespace } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

// Note: createActorClass stamps __actorKitContractName on the DO class,
// but testing it requires CF DurableObject runtime. The stamp is verified
// indirectly via integration tests. These unit tests validate the resolution
// logic that consumes the stamp.

describe("resolveNamespace()", () => {
  it("finds a namespace via exports by contract name", () => {
    const fakeNamespace = {
      __actorKitContractName: "counter",
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const exports = { CounterDO: fakeNamespace };
    const env = {};

    const result = resolveNamespace("counter", exports, env);
    expect(result).toBe(fakeNamespace);
  });

  it("falls back to env binding when not found in exports", () => {
    const fakeBinding = {
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const exports = {};
    const env = { COUNTER: fakeBinding };

    const result = resolveNamespace("counter", exports, env);
    expect(result).toBe(fakeBinding);
  });

  it("falls back to env binding when exports is undefined", () => {
    const fakeBinding = {
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const env = { COUNTER: fakeBinding };

    const result = resolveNamespace("counter", undefined, env);
    expect(result).toBe(fakeBinding);
  });

  it("throws when not found in exports or env", () => {
    expect(() => resolveNamespace("counter", {}, {})).toThrow(
      'Actor "counter" not found in ctx.exports or env.COUNTER',
    );
  });

  it("converts hyphenated contract names to uppercase env bindings", () => {
    const fakeBinding = {
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const env = { CHAT_ROOM: fakeBinding };

    const result = resolveNamespace("chat-room", undefined, env);
    expect(result).toBe(fakeBinding);
  });

  it("selects the correct namespace from multiple exports", () => {
    const counterNs = {
      __actorKitContractName: "counter",
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const profileNs = {
      __actorKitContractName: "profile",
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const exports = { CounterDO: counterNs, ProfileDO: profileNs };
    const env = {};

    expect(resolveNamespace("counter", exports, env)).toBe(counterNs);
    expect(resolveNamespace("profile", exports, env)).toBe(profileNs);
  });

  it("prefers exports over env binding", () => {
    const exportsNs = {
      __actorKitContractName: "counter",
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const envBinding = {
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const exports = { CounterDO: exportsNs };
    const env = { COUNTER: envBinding };

    const result = resolveNamespace("counter", exports, env);
    expect(result).toBe(exportsNs);
  });

  it("skips non-object values in exports", () => {
    const fakeBinding = {
      idFromName: () => ({ toString: () => "id" }),
      get: () => ({}),
    };
    const exports = { someString: "not-a-namespace", someNull: null };
    const env = { COUNTER: fakeBinding };

    const result = resolveNamespace("counter", exports, env);
    expect(result).toBe(fakeBinding);
  });
});
