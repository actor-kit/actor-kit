import { describe, it, expect } from "vitest";
import { schema, uint8, uint16, uint32, float32, float64, string, boolean, array } from "../../packages/actor-kit/src/schema/schema";
import { encode, decode } from "../../packages/actor-kit/src/schema/binary";

describe("binary encoder/decoder", () => {
  describe("primitives", () => {
    it("round-trips uint8", () => {
      const S = schema({ value: uint8 });
      const data = { value: 42 };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips uint16", () => {
      const S = schema({ value: uint16 });
      const data = { value: 1234 };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips uint32", () => {
      const S = schema({ value: uint32 });
      const data = { value: 123456789 };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips float32", () => {
      const S = schema({ value: float32 });
      const data = { value: 3.140000104904175 }; // float32 precision
      const result = decode(S, encode(S, { value: 3.14 }));
      expect(Math.abs((result as { value: number }).value - 3.14)).toBeLessThan(0.001);
    });

    it("round-trips float64", () => {
      const S = schema({ value: float64 });
      const data = { value: 3.141592653589793 };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips string", () => {
      const S = schema({ value: string });
      const data = { value: "hello world" };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips empty string", () => {
      const S = schema({ value: string });
      const data = { value: "" };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips boolean true", () => {
      const S = schema({ value: boolean });
      expect(decode(S, encode(S, { value: true }))).toEqual({ value: true });
    });

    it("round-trips boolean false", () => {
      const S = schema({ value: boolean });
      expect(decode(S, encode(S, { value: false }))).toEqual({ value: false });
    });
  });

  describe("multiple fields", () => {
    it("round-trips multiple primitives in order", () => {
      const S = schema({ x: float32, y: float32, z: float32, health: uint32, name: string });
      const data = { x: 1.5, y: 2.5, z: 3.5, health: 100, name: "player1" };
      const result = decode(S, encode(S, data));
      expect((result as { health: number }).health).toBe(100);
      expect((result as { name: string }).name).toBe("player1");
    });
  });

  describe("arrays", () => {
    it("round-trips array of uint32", () => {
      const S = schema({ scores: array(uint32) });
      const data = { scores: [10, 20, 30] };
      expect(decode(S, encode(S, data))).toEqual(data);
    });

    it("round-trips empty array", () => {
      const S = schema({ items: array(string) });
      const data = { items: [] };
      expect(decode(S, encode(S, data))).toEqual(data);
    });
  });

  describe("nested schemas", () => {
    it("round-trips nested schema", () => {
      const Inner = schema({ id: uint32, name: string });
      const Outer = schema({ item: Inner });
      const data = { item: { id: 42, name: "test" } };
      expect(decode(Outer, encode(Outer, data))).toEqual(data);
    });

    it("round-trips array of nested schemas", () => {
      const Item = schema({ id: uint32, text: string, done: boolean });
      const ListView = schema({ items: array(Item), count: uint32 });
      const data = {
        items: [
          { id: 1, text: "Buy milk", done: false },
          { id: 2, text: "Walk dog", done: true },
        ],
        count: 2,
      };
      expect(decode(ListView, encode(ListView, data))).toEqual(data);
    });
  });

  describe("encoding size", () => {
    it("position update is compact", () => {
      const PosView = schema({ x: float32, y: float32, z: float32 });
      const bytes = encode(PosView, { x: 1.0, y: 2.0, z: 3.0 });
      // 3 floats × 4 bytes = 12 bytes
      expect(bytes.byteLength).toBe(12);
    });

    it("uint8 is 1 byte", () => {
      const S = schema({ v: uint8 });
      expect(encode(S, { v: 255 }).byteLength).toBe(1);
    });

    it("boolean is 1 byte", () => {
      const S = schema({ v: boolean });
      expect(encode(S, { v: true }).byteLength).toBe(1);
    });
  });
});
