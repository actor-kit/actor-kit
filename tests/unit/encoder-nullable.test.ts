import { array, boolean, decode, encode, nullable, schema, string, uint8, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("binary encoder/decoder with nullable fields", () => {
  describe("snapshot encoding", () => {
    it("encodes null for a nullable string field", () => {
      const S = schema({ name: nullable(string), count: uint32 });
      const data = { name: null, count: 5 };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.name).toBeNull();
      expect(decoded.count).toBe(5);
    });

    it("encodes a non-null value for a nullable string field", () => {
      const S = schema({ name: nullable(string), count: uint32 });
      const data = { name: "alice", count: 10 };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.name).toBe("alice");
      expect(decoded.count).toBe(10);
    });

    it("encodes null for a nullable uint32 field", () => {
      const S = schema({ score: nullable(uint32) });
      const data = { score: null };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.score).toBeNull();
    });

    it("encodes non-null for a nullable uint32 field", () => {
      const S = schema({ score: nullable(uint32) });
      const data = { score: 42 };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.score).toBe(42);
    });

    it("encodes null for a nullable boolean field", () => {
      const S = schema({ active: nullable(boolean) });
      const data = { active: null };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.active).toBeNull();
    });

    it("encodes null for a nullable nested schema", () => {
      const Card = schema({ suit: string, rank: uint8 });
      const S = schema({ card: nullable(Card) });
      const data = { card: null };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.card).toBeNull();
    });

    it("encodes non-null for a nullable nested schema", () => {
      const Card = schema({ suit: string, rank: uint8 });
      const S = schema({ card: nullable(Card) });
      const data = { card: { suit: "hearts", rank: 10 } };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.card).toEqual({ suit: "hearts", rank: 10 });
    });

    it("encodes null for a nullable array field", () => {
      const S = schema({ items: nullable(array(uint32)) });
      const data = { items: null };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.items).toBeNull();
    });

    it("encodes non-null for a nullable array field", () => {
      const S = schema({ items: nullable(array(uint32)) });
      const data = { items: [1, 2, 3] };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.items).toEqual([1, 2, 3]);
    });

    it("multiple nullable fields: mix of null and non-null", () => {
      const S = schema({
        a: nullable(string),
        b: uint32,
        c: nullable(uint32),
        d: string,
      });
      const data = { a: null, b: 5, c: 42, d: "hello" };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.a).toBeNull();
      expect(decoded.b).toBe(5);
      expect(decoded.c).toBe(42);
      expect(decoded.d).toBe("hello");
    });

    it("all nullable fields null", () => {
      const S = schema({
        a: nullable(string),
        b: nullable(uint32),
        c: nullable(boolean),
      });
      const data = { a: null, b: null, c: null };
      const bytes = encode(S, data);
      const decoded = decode(S, bytes);
      expect(decoded.a).toBeNull();
      expect(decoded.b).toBeNull();
      expect(decoded.c).toBeNull();
    });
  });

  describe("zero overhead for non-nullable schemas", () => {
    it("produces byte-identical output to a schema without nullable fields", () => {
      const S = schema({ count: uint32, name: string });
      const data = { count: 5, name: "alice" };
      const bytesNow = encode(S, data);

      // Manually verify: uint32(4) + varint length prefix(1) + "alice"(5) = 10 bytes
      // No null mask overhead
      expect(bytesNow.byteLength).toBe(10);

      const decoded = decode(S, bytesNow);
      expect(decoded.count).toBe(5);
      expect(decoded.name).toBe("alice");
    });
  });

  describe("null bitmask is compact", () => {
    it("null values take zero value bytes", () => {
      const WithNull = schema({ name: nullable(string), count: uint32 });
      const NonNull = schema({ name: nullable(string), count: uint32 });

      const nullBytes = encode(WithNull, { name: null, count: 5 });
      const valueBytes = encode(NonNull, { name: "hello", count: 5 });

      // The null version should be smaller — no string length prefix or UTF-8 bytes
      expect(nullBytes.byteLength).toBeLessThan(valueBytes.byteLength);
    });
  });
});
