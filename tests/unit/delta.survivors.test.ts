import {
  applyDelta,
  array,
  boolean,
  encodeDelta,
  float32,
  float64,
  schema,
  string,
  uint8,
  uint16,
  uint32,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("delta encoding — kill survivors", () => {
  it("detects string field change", () => {
    const S = schema({ name: string, age: uint32 });
    const prev = { name: "alice", age: 30 };
    const next = { name: "bob", age: 30 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.name).toBe("bob");
    expect(result.age).toBe(30);
  });

  it("detects boolean field change", () => {
    const S = schema({ active: boolean, count: uint32 });
    const prev = { active: true, count: 5 };
    const next = { active: false, count: 5 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.active).toBe(false);
  });

  it("detects uint8 change", () => {
    const S = schema({ level: uint8, name: string });
    const prev = { level: 1, name: "a" };
    const next = { level: 2, name: "a" };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.level).toBe(2);
  });

  it("detects uint16 change", () => {
    const S = schema({ port: uint16, name: string });
    const prev = { port: 8080, name: "a" };
    const next = { port: 3000, name: "a" };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.port).toBe(3000);
  });

  it("detects float64 change", () => {
    const S = schema({ precise: float64, label: string });
    const prev = { precise: 3.141592653589793, label: "pi" };
    const next = { precise: 2.718281828459045, label: "pi" };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.precise).toBeCloseTo(2.718281828459045, 10);
  });

  it("detects array change", () => {
    const S = schema({ items: array(uint32), total: uint32 });
    const prev = { items: [1, 2, 3], total: 6 };
    const next = { items: [1, 2, 3, 4], total: 10 };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.items).toEqual([1, 2, 3, 4]);
    expect(result.total).toBe(10);
  });

  it("detects nested schema change", () => {
    const Inner = schema({ x: float32, y: float32 });
    const S = schema({ pos: Inner, name: string });
    const prev = { pos: { x: 0, y: 0 }, name: "a" };
    const next = { pos: { x: 1, y: 2 }, name: "a" };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect((result.pos as { x: number }).x).toBeCloseTo(1, 0);
    expect((result.pos as { y: number }).y).toBeCloseTo(2, 0);
  });

  it("handles empty string delta", () => {
    const S = schema({ label: string });
    const prev = { label: "hello" };
    const next = { label: "" };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.label).toBe("");
  });

  it("handles empty array delta", () => {
    const S = schema({ items: array(uint32) });
    const prev = { items: [1, 2, 3] };
    const next = { items: [] };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.items).toEqual([]);
  });

  it("delta size is smaller than full snapshot for single field change", () => {
    const S = schema({
      a: uint32,
      b: uint32,
      c: uint32,
      d: uint32,
      e: string,
      f: boolean,
    });
    const prev = { a: 1, b: 2, c: 3, d: 4, e: "hello", f: true };
    const next = { a: 1, b: 2, c: 99, d: 4, e: "hello", f: true };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    // Delta: 1 byte bitmask + 4 bytes uint32 = 5 bytes
    // Full: 4*4 + 7 + 1 = 24 bytes
    expect(delta!.byteLength).toBeLessThan(10);
  });

  it("array of nested schemas in delta", () => {
    const Item = schema({ id: uint32, name: string });
    const S = schema({ items: array(Item) });
    const prev = { items: [{ id: 1, name: "a" }] };
    const next = {
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    };
    const delta = encodeDelta(S, prev, next);
    expect(delta).not.toBeNull();
    const result = applyDelta(S, prev, delta!);
    expect(result.items).toHaveLength(2);
  });
});
