import { array, boolean, float32, type Infer, nullable, schema, string, uint8, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("nullable() combinator", () => {
  describe("descriptor shape", () => {
    it("wraps a primitive descriptor", () => {
      const field = nullable(string);
      expect(field.kind).toBe("nullable");
      expect(field.type).toBe("nullable");
      expect(field.field).toBe(string);
    });

    it("wraps uint32", () => {
      const field = nullable(uint32);
      expect(field.kind).toBe("nullable");
      expect(field.field.kind).toBe("primitive");
      expect(field.field.type).toBe("uint32");
    });

    it("wraps boolean", () => {
      const field = nullable(boolean);
      expect(field.kind).toBe("nullable");
      expect(field.field).toBe(boolean);
    });
  });

  describe("wraps non-primitive types", () => {
    it("wraps a nested schema", () => {
      const Card = schema({ suit: string, rank: uint8 });
      const field = nullable(Card);
      expect(field.kind).toBe("nullable");
      expect(field.field.kind).toBe("schema");
      expect(field.field).toBe(Card);
    });

    it("wraps an array", () => {
      const field = nullable(array(uint32));
      expect(field.kind).toBe("nullable");
      expect(field.field.kind).toBe("array");
    });
  });

  describe("schema integration", () => {
    it("builds a schema containing nullable fields", () => {
      const S = schema({ name: nullable(string), count: uint32 });
      expect(S.fields).toHaveLength(2);
      expect(S.fields[0]?.type).toBe("nullable");
      expect(S.fields[1]?.type).toBe("uint32");
    });

    it("sets hasNullable: true when schema has nullable fields", () => {
      const S = schema({ name: nullable(string), count: uint32 });
      expect(S.hasNullable).toBe(true);
    });

    it("sets hasNullable: false when schema has no nullable fields", () => {
      const S = schema({ count: uint32, name: string });
      expect(S.hasNullable).toBe(false);
    });

    it("schema with nullable field is frozen", () => {
      const S = schema({ name: nullable(string) });
      expect(Object.isFrozen(S)).toBe(true);
    });
  });

  describe("type inference", () => {
    it("infers string | null for nullable(string)", () => {
      const S = schema({ name: nullable(string) });
      // Type-level test: null must be assignable
      const withNull: Infer<typeof S> = { name: null };
      const withValue: Infer<typeof S> = { name: "alice" };
      expect(withNull.name).toBeNull();
      expect(withValue.name).toBe("alice");
    });

    it("infers number | null for nullable(uint32)", () => {
      const S = schema({ score: nullable(uint32) });
      const withNull: Infer<typeof S> = { score: null };
      const withValue: Infer<typeof S> = { score: 42 };
      expect(withNull.score).toBeNull();
      expect(withValue.score).toBe(42);
    });

    it("infers boolean | null for nullable(boolean)", () => {
      const S = schema({ active: nullable(boolean) });
      const withNull: Infer<typeof S> = { active: null };
      const withValue: Infer<typeof S> = { active: true };
      expect(withNull.active).toBeNull();
      expect(withValue.active).toBe(true);
    });

    it("infers { suit: string; rank: number } | null for nullable nested schema", () => {
      const Card = schema({ suit: string, rank: uint8 });
      const S = schema({ card: nullable(Card) });
      const withNull: Infer<typeof S> = { card: null };
      const withValue: Infer<typeof S> = { card: { suit: "hearts", rank: 10 } };
      expect(withNull.card).toBeNull();
      expect(withValue.card?.suit).toBe("hearts");
    });

    it("infers number[] | null for nullable(array(uint32))", () => {
      const S = schema({ scores: nullable(array(uint32)) });
      const withNull: Infer<typeof S> = { scores: null };
      const withValue: Infer<typeof S> = { scores: [1, 2, 3] };
      expect(withNull.scores).toBeNull();
      expect(withValue.scores).toEqual([1, 2, 3]);
    });

    it("infers number | null for nullable(float32)", () => {
      const S = schema({ temp: nullable(float32) });
      const withNull: Infer<typeof S> = { temp: null };
      const withValue: Infer<typeof S> = { temp: 98.6 };
      expect(withNull.temp).toBeNull();
      expect(withValue.temp).toBe(98.6);
    });

    it("works alongside non-nullable fields", () => {
      const S = schema({
        count: uint32,
        lastUpdatedBy: nullable(string),
        active: boolean,
      });
      const check: Infer<typeof S> = {
        count: 5,
        lastUpdatedBy: null,
        active: true,
      };
      expect(check.count).toBe(5);
      expect(check.lastUpdatedBy).toBeNull();
      expect(check.active).toBe(true);
    });
  });
});
