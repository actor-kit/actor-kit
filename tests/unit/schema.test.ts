import { array, boolean, float32, float64, type Infer, schema, string, uint8, uint16, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("schema() builder", () => {
  describe("primitive types", () => {
    it("creates a schema with uint32 field", () => {
      const CounterView = schema({ count: uint32 });
      expect(CounterView.fields).toHaveLength(1);
      expect(CounterView.fields[0]?.name).toBe("count");
      expect(CounterView.fields[0]?.type).toBe("uint32");
    });

    it("creates a schema with multiple primitive fields", () => {
      const PlayerView = schema({
        x: float32,
        y: float32,
        health: uint32,
        name: string,
        alive: boolean,
      });
      expect(PlayerView.fields).toHaveLength(5);
      expect(PlayerView.fields[0]?.type).toBe("float32");
      expect(PlayerView.fields[1]?.type).toBe("float32");
      expect(PlayerView.fields[2]?.type).toBe("uint32");
      expect(PlayerView.fields[3]?.type).toBe("string");
      expect(PlayerView.fields[4]?.type).toBe("boolean");
    });

    it("preserves field order from definition", () => {
      const S = schema({ a: uint8, b: uint16, c: uint32, d: float64 });
      const names = S.fields.map((f) => f.name);
      expect(names).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("array combinator", () => {
    it("creates an array field of primitives", () => {
      const S = schema({ scores: array(uint32) });
      expect(S.fields).toHaveLength(1);
      expect(S.fields[0]?.type).toBe("array");
      expect(S.fields[0]?.element?.type).toBe("uint32");
    });
  });

  describe("nested schemas", () => {
    it("supports nested schema definitions", () => {
      const Inner = schema({ id: uint32, name: string });
      const Outer = schema({ item: Inner });
      expect(Outer.fields).toHaveLength(1);
      expect(Outer.fields[0]?.type).toBe("schema");
      expect(Outer.fields[0]?.schema).toBe(Inner);
    });

    it("supports array of nested schemas", () => {
      const Item = schema({ id: uint32, text: string, done: boolean });
      const ListView = schema({ items: array(Item), count: uint32 });
      expect(ListView.fields).toHaveLength(2);
      expect(ListView.fields[0]?.type).toBe("array");
      expect(ListView.fields[0]?.element?.type).toBe("schema");
      expect(ListView.fields[0]?.element?.schema).toBe(Item);
    });
  });

  describe("immutability", () => {
    it("schema objects are frozen", () => {
      const S = schema({ count: uint32 });
      expect(Object.isFrozen(S)).toBe(true);
      expect(Object.isFrozen(S.fields)).toBe(true);
    });
  });

  describe("type inference", () => {
    it("infers correct types from schema definition", () => {
      const TodoItem = schema({ id: string, text: string, done: boolean });
      const OwnerView = schema({
        todos: array(TodoItem),
        memberCount: uint32,
      });

      // Type-level test: this should compile without errors.
      // If the inference is wrong, TypeScript will catch it at typecheck time.
      const _check: Infer<typeof OwnerView> = {
        todos: [{ id: "1", text: "test", done: false }],
        memberCount: 5,
      };
      expect(_check.todos).toHaveLength(1);
      expect(_check.memberCount).toBe(5);
    });

    it("infers number for all numeric types", () => {
      const S = schema({
        a: uint8,
        b: uint16,
        c: uint32,
        d: float32,
        e: float64,
      });

      const _check: Infer<typeof S> = {
        a: 1,
        b: 2,
        c: 3,
        d: 4.5,
        e: 6.7,
      };
      expect(_check.a).toBe(1);
    });

    it("infers string for string type", () => {
      const S = schema({ name: string });
      const _check: Infer<typeof S> = { name: "hello" };
      expect(_check.name).toBe("hello");
    });

    it("infers boolean for boolean type", () => {
      const S = schema({ active: boolean });
      const _check: Infer<typeof S> = { active: true };
      expect(_check.active).toBe(true);
    });
  });
});
