import { applyDelta, encodeDelta, nullable, schema, string, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("delta encoder/decoder with nullable fields", () => {
  const S = schema({
    name: nullable(string),
    count: uint32,
    score: nullable(uint32),
  });

  it("returns null when no fields changed", () => {
    const prev = { name: "alice", count: 5, score: 42 };
    const next = { name: "alice", count: 5, score: 42 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).toBeNull();
  });

  it("returns null when nullable fields are both null and unchanged", () => {
    const prev = { name: null, count: 5, score: null };
    const next = { name: null, count: 5, score: null };
    const delta = encodeDelta(S, prev, next);
    expect(delta).toBeNull();
  });

  it("encodes value → value transition", () => {
    const prev = { name: "alice", count: 5, score: 42 };
    const next = { name: "bob", count: 5, score: 42 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    if (delta === null) return;
    const result = applyDelta(S, prev, delta);
    expect(result.name).toBe("bob");
    expect(result.count).toBe(5);
    expect(result.score).toBe(42);
  });

  it("encodes value → null transition", () => {
    const prev = { name: "alice", count: 5, score: 42 };
    const next = { name: null, count: 5, score: 42 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    if (delta === null) return;
    const result = applyDelta(S, prev, delta);
    expect(result.name).toBeNull();
    expect(result.count).toBe(5);
    expect(result.score).toBe(42);
  });

  it("encodes null → value transition", () => {
    const prev = { name: null, count: 5, score: null };
    const next = { name: "alice", count: 5, score: null };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    if (delta === null) return;
    const result = applyDelta(S, prev, delta);
    expect(result.name).toBe("alice");
    expect(result.count).toBe(5);
    expect(result.score).toBeNull();
  });

  it("encodes null → null (no change) for nullable field", () => {
    const prev = { name: null, count: 5, score: null };
    const next = { name: null, count: 10, score: null };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    if (delta === null) return;
    const result = applyDelta(S, prev, delta);
    expect(result.name).toBeNull();
    expect(result.count).toBe(10);
    expect(result.score).toBeNull();
  });

  it("encodes multiple nullable field changes in one delta", () => {
    const prev = { name: "alice", count: 5, score: 42 };
    const next = { name: null, count: 5, score: null };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    if (delta === null) return;
    const result = applyDelta(S, prev, delta);
    expect(result.name).toBeNull();
    expect(result.count).toBe(5);
    expect(result.score).toBeNull();
  });

  it("encodes null → value for multiple nullable fields simultaneously", () => {
    const prev = { name: null, count: 5, score: null };
    const next = { name: "bob", count: 5, score: 99 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    if (delta === null) return;
    const result = applyDelta(S, prev, delta);
    expect(result.name).toBe("bob");
    expect(result.count).toBe(5);
    expect(result.score).toBe(99);
  });

  it("value → null takes zero value bytes (compact)", () => {
    const prev = { name: "a-long-string-here", count: 5, score: 42 };
    const nextToNull = { name: null, count: 5, score: 42 };
    const nextToString = { name: "another-long-string", count: 5, score: 42 };
    const deltaNull = encodeDelta(S, prev, nextToNull);
    const deltaString = encodeDelta(S, prev, nextToString);
    expect(deltaNull).not.toBeNull();
    expect(deltaString).not.toBeNull();
    if (deltaNull === null || deltaString === null) return;
    // Null delta should be smaller — no string bytes
    expect(deltaNull.byteLength).toBeLessThan(deltaString.byteLength);
  });

  describe("non-nullable schemas are unaffected", () => {
    it("produces identical delta format for schemas without nullable fields", () => {
      const Plain = schema({ count: uint32, name: string });
      const prev = { count: 5, name: "alice" };
      const next = { count: 10, name: "alice" };
      const delta = encodeDelta(Plain, prev, next);
      expect(delta).not.toBeNull();
      if (delta === null) return;
      // bitmask(1) + uint32(4) = 5 bytes (no null mask overhead)
      expect(delta.byteLength).toBe(5);
      const result = applyDelta(Plain, prev, delta);
      expect(result.count).toBe(10);
      expect(result.name).toBe("alice");
    });
  });
});
