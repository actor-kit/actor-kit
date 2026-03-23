import { describe, expect, it } from "vitest";
import { decode, encode } from "../../packages/actor-kit/src/schema/binary";
import { array, boolean, float32, float64, schema, string, uint8, uint16, uint32 } from "../../packages/actor-kit/src/schema/schema";

describe("binary encode/decode — kill survivors", () => {
  it("uint8 max value (255)", () => {
    const S = schema({ v: uint8 });
    expect(decode(S, encode(S, { v: 255 }))).toEqual({ v: 255 });
  });

  it("uint8 zero", () => {
    const S = schema({ v: uint8 });
    expect(decode(S, encode(S, { v: 0 }))).toEqual({ v: 0 });
  });

  it("uint16 max value (65535)", () => {
    const S = schema({ v: uint16 });
    expect(decode(S, encode(S, { v: 65535 }))).toEqual({ v: 65535 });
  });

  it("uint32 max value (4294967295)", () => {
    const S = schema({ v: uint32 });
    expect(decode(S, encode(S, { v: 4294967295 }))).toEqual({ v: 4294967295 });
  });

  it("float32 negative", () => {
    const S = schema({ v: float32 });
    const result = decode(S, encode(S, { v: -1.5 }));
    expect((result as { v: number }).v).toBeCloseTo(-1.5, 1);
  });

  it("float64 very large", () => {
    const S = schema({ v: float64 });
    expect(decode(S, encode(S, { v: 1e308 }))).toEqual({ v: 1e308 });
  });

  it("float64 very small", () => {
    const S = schema({ v: float64 });
    expect(decode(S, encode(S, { v: 5e-324 }))).toEqual({ v: 5e-324 });
  });

  it("string with unicode", () => {
    const S = schema({ v: string });
    expect(decode(S, encode(S, { v: "héllo 世界 🌍" }))).toEqual({ v: "héllo 世界 🌍" });
  });

  it("long string (1000 chars)", () => {
    const S = schema({ v: string });
    const longStr = "a".repeat(1000);
    expect(decode(S, encode(S, { v: longStr }))).toEqual({ v: longStr });
  });

  it("array of strings", () => {
    const S = schema({ items: array(string) });
    const data = { items: ["hello", "world", "foo"] };
    expect(decode(S, encode(S, data))).toEqual(data);
  });

  it("array of booleans", () => {
    const S = schema({ flags: array(boolean) });
    const data = { flags: [true, false, true, false] };
    expect(decode(S, encode(S, data))).toEqual(data);
  });

  it("nested schema with all types", () => {
    const Inner = schema({
      a: uint8,
      b: uint16,
      c: uint32,
      d: float32,
      e: float64,
      f: string,
      g: boolean,
    });
    const Outer = schema({ inner: Inner });
    const data = { inner: { a: 1, b: 2, c: 3, d: 4.5, e: 6.7, f: "hi", g: true } };
    const result = decode(Outer, encode(Outer, data));
    expect((result as { inner: { a: number } }).inner.a).toBe(1);
    expect((result as { inner: { f: string } }).inner.f).toBe("hi");
    expect((result as { inner: { g: boolean } }).inner.g).toBe(true);
  });

  it("multiple fields maintain order", () => {
    const S = schema({ z: uint32, a: uint32, m: uint32 });
    const data = { z: 1, a: 2, m: 3 };
    expect(decode(S, encode(S, data))).toEqual(data);
  });

  it("array of float32", () => {
    const S = schema({ coords: array(float32) });
    const data = { coords: [1.0, 2.0, 3.0] };
    const result = decode(S, encode(S, data)) as { coords: number[] };
    expect(result.coords.length).toBe(3);
    expect(result.coords[0]).toBeCloseTo(1.0, 1);
  });

  it("empty schema round-trips", () => {
    const S = schema({});
    const data = {};
    expect(decode(S, encode(S, data))).toEqual(data);
  });

  it("encode size is deterministic", () => {
    const S = schema({ a: uint32, b: string });
    const data = { a: 42, b: "hi" };
    const bytes1 = encode(S, data);
    const bytes2 = encode(S, data);
    expect(bytes1.byteLength).toBe(bytes2.byteLength);
    expect(Array.from(bytes1)).toEqual(Array.from(bytes2));
  });
});
