import {
  applyDelta,
  array,
  boolean,
  decode,
  encode,
  encodeDelta,
  float32,
  float64,
  nullable,
  schema,
  string,
  uint8,
  uint16,
  uint32,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";

// Byte-level pins for docs/binary-protocol.md. Every multi-byte integer is big-endian.

/** Runtime data that did not come from typed code (JS callers, persisted state). */
function untyped(json: string) {
  return JSON.parse(json);
}

const bytes = (...b: number[]) => new Uint8Array(b);

/** Copies `payload` into a larger buffer so it is read through a non-zero byteOffset. */
function atOffset(payload: Uint8Array, pad = 5): Uint8Array {
  const buf = new Uint8Array(pad + payload.byteLength + 3).fill(0xee);
  buf.set(payload, pad);
  return buf.subarray(pad, pad + payload.byteLength);
}

describe("encode — primitive layout", () => {
  it("writes integers and booleans big-endian in field order", () => {
    const S = schema({ a: uint8, b: uint16, c: uint32, d: boolean, e: boolean });
    expect(encode(S, { a: 1, b: 0x0203, c: 0x04050607, d: true, e: false })).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 1, 0));
  });

  it("writes floats as big-endian IEEE 754", () => {
    const S = schema({ f: float32, d: float64 });
    expect(encode(S, { f: 1.5, d: 1.5 })).toEqual(bytes(0x3f, 0xc0, 0, 0, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0));
  });

  it("prefixes strings with their UTF-8 byte length", () => {
    const S = schema({ s: string });
    expect(encode(S, { s: "hé" })).toEqual(bytes(3, 0x68, 0xc3, 0xa9));
  });

  it("prefixes arrays with their element count", () => {
    const S = schema({ l: array(uint16) });
    expect(encode(S, { l: [1, 0x0102] })).toEqual(bytes(2, 0, 1, 1, 2));
  });

  it("encodes arrays of arrays with a count per level", () => {
    const S = schema({ l: array(array(uint8)) });
    const data = { l: [[1], [2, 3]] };
    const encoded = encode(S, data);
    expect(encoded).toEqual(bytes(2, 1, 1, 2, 2, 3));
    expect(decode(S, encoded)).toEqual(data);
  });

  it("encodes arrays of schemas as consecutive nested values", () => {
    const Item = schema({ id: uint8, label: string });
    const S = schema({ items: array(Item), n: uint8 });
    const data = {
      items: [
        { id: 1, label: "a" },
        { id: 2, label: "" },
      ],
      n: 9,
    };
    const encoded = encode(S, data);
    expect(encoded).toEqual(bytes(2, 1, 1, 0x61, 2, 0, 9));
    expect(decode(S, encoded)).toEqual(data);
  });

  it("encodes nested schemas inline", () => {
    const S = schema({ p: schema({ x: uint8, y: uint16 }), z: uint8 });
    expect(encode(S, { p: { x: 1, y: 2 }, z: 3 })).toEqual(bytes(1, 0, 2, 3));
  });
});

describe("encode — values that do not match the schema", () => {
  it("writes zero values for missing fields", () => {
    const Inner = schema({ k: uint8 });
    const S = schema({
      a: uint8,
      f: float32,
      d: float64,
      s: string,
      l: array(uint8),
      b: boolean,
      n: Inner,
      u: uint32,
    });
    expect(encode(S, untyped("{}"))).toEqual(new Uint8Array(1 + 4 + 8 + 1 + 1 + 1 + 1 + 4));
  });

  it("writes zero for null numbers", () => {
    const S = schema({ f: float32, d: float64, a: uint16 });
    expect(encode(S, untyped('{"f":null,"d":null,"a":null}'))).toEqual(new Uint8Array(14));
  });

  it("stringifies non-string values in string fields", () => {
    const S = schema({ s: string });
    expect(decode(S, encode(S, untyped('{"s":42}')))).toEqual({ s: "42" });
  });

  it("coerces numeric strings in number fields", () => {
    const S = schema({ a: uint8, f: float32 });
    expect(decode(S, encode(S, untyped('{"a":"7","f":"0.5"}')))).toEqual({ a: 7, f: 0.5 });
  });

  it("writes truthiness for booleans", () => {
    const S = schema({ t: boolean, f: boolean });
    expect(encode(S, untyped('{"t":"yes","f":0}'))).toEqual(bytes(1, 0));
  });

  it("treats a non-array value in an array field as empty", () => {
    const S = schema({ l: array(uint8), n: uint8 });
    expect(encode(S, untyped('{"l":"abc","n":4}'))).toEqual(bytes(0, 4));
  });

  it("treats a non-object value in a nested schema field as empty", () => {
    const S = schema({ p: schema({ x: uint8, s: string }), n: uint8 });
    expect(encode(S, untyped('{"p":5,"n":4}'))).toEqual(bytes(0, 0, 4));
    expect(encode(S, untyped('{"p":null,"n":4}'))).toEqual(bytes(0, 0, 4));
  });

  it("treats non-object array elements of a schema array as empty", () => {
    const S = schema({ l: array(schema({ x: uint8 })) });
    expect(encode(S, untyped('{"l":[3,null]}'))).toEqual(bytes(2, 0, 0));
  });
});

describe("encode — nullable fields", () => {
  const S = schema({ a: nullable(uint8), b: uint8, c: nullable(string) });

  it("prepends a null bitmask with one bit per nullable field, in order", () => {
    expect(encode(S, { a: null, b: 2, c: "x" })).toEqual(bytes(0b01, 2, 1, 0x78));
    expect(encode(S, { a: 1, b: 2, c: null })).toEqual(bytes(0b10, 1, 2));
    expect(encode(S, { a: null, b: 2, c: null })).toEqual(bytes(0b11, 2));
    expect(encode(S, { a: 1, b: 2, c: "" })).toEqual(bytes(0, 1, 2, 0));
  });

  it("uses a second bitmask byte for the ninth nullable field", () => {
    const N = schema({
      n0: nullable(uint8),
      n1: nullable(uint8),
      n2: nullable(uint8),
      n3: nullable(uint8),
      n4: nullable(uint8),
      n5: nullable(uint8),
      n6: nullable(uint8),
      n7: nullable(uint8),
      plain: uint8,
      n8: nullable(uint8),
    });
    const data = { n0: null, n1: 1, n2: 2, n3: null, n4: 4, n5: 5, n6: 6, n7: 7, plain: 99, n8: null };
    const encoded = encode(N, data);
    expect(encoded).toEqual(bytes(0b0000_1001, 0b0000_0001, 1, 2, 4, 5, 6, 7, 99));
    expect(decode(N, encoded)).toEqual(data);
    expect(decode(N, atOffset(encoded))).toEqual(data);

    const lastOnly = { ...data, n0: 0, n3: 3, n8: null };
    expect(encode(N, lastOnly).subarray(0, 2)).toEqual(bytes(0, 1));
    expect(decode(N, encode(N, lastOnly))).toEqual(lastOnly);
  });

  it("encodes non-null nullable arrays and schemas like their inner type", () => {
    const Inner = schema({ x: uint8 });
    const T = schema({ l: nullable(array(uint8)), p: nullable(Inner) });
    const data = { l: [5, 6], p: { x: 7 } };
    const encoded = encode(T, data);
    expect(encoded).toEqual(bytes(0, 2, 5, 6, 7));
    expect(decode(T, encoded)).toEqual(data);
    expect(encode(T, { l: null, p: null })).toEqual(bytes(0b11));
    expect(decode(T, bytes(0b11))).toEqual({ l: null, p: null });
  });

  it("gives nested schemas their own null bitmask", () => {
    const Inner = schema({ nick: nullable(string), hp: uint8 });
    const T = schema({ p: Inner, q: nullable(uint8) });
    const data = { p: { nick: null, hp: 5 }, q: 3 };
    const encoded = encode(T, data);
    expect(encoded).toEqual(bytes(0, 0b1, 5, 3));
    expect(decode(T, encoded)).toEqual(data);
  });
});

describe("decode", () => {
  it("reads through the byteOffset of a subarray", () => {
    const S = schema({ a: uint16, s: string, f: float64, l: array(uint8) });
    const data = { a: 513, s: "hi", f: -2.25, l: [1, 2] };
    expect(decode(S, atOffset(encode(S, data)))).toEqual(data);
  });

  it("reads any non-zero byte as true", () => {
    const S = schema({ a: boolean, b: boolean });
    expect(decode(S, bytes(2, 0))).toEqual({ a: true, b: false });
  });

  it("reads uint32 values above 2^31 as unsigned", () => {
    const S = schema({ c: uint32 });
    expect(decode(S, bytes(0xff, 0xff, 0xff, 0xfe))).toEqual({ c: 0xfffffffe });
  });
});

describe("encodeDelta — layout", () => {
  it("returns null when nothing changed, including deep-equal arrays and objects", () => {
    const S = schema({ l: array(uint8), p: schema({ x: uint8 }) });
    expect(encodeDelta(S, { l: [1, 2], p: { x: 1 } }, { l: [1, 2], p: { x: 1 } })).toBeNull();
  });

  it("treats float differences below 1e-6 as unchanged", () => {
    const S = schema({ f: float64 });
    expect(encodeDelta(S, { f: 1 }, { f: 1 + 5e-7 })).toBeNull();
    expect(encodeDelta(S, { f: 0 }, { f: 1e-6 })).not.toBeNull();
    expect(encodeDelta(S, { f: 2 }, { f: 1 })).not.toBeNull();
  });

  it("treats NaN as always changed", () => {
    const S = schema({ f: float64 });
    expect(encodeDelta(S, { f: Number.NaN }, { f: Number.NaN })).not.toBeNull();
  });

  it("treats a type change as a change", () => {
    const S = schema({ s: string });
    expect(encodeDelta(S, untyped('{"s":1}'), untyped('{"s":"1"}'))).not.toBeNull();
  });

  it("writes a change bitmask and only the changed fields", () => {
    const S = schema({ a: uint8, b: uint16, c: string });
    expect(encodeDelta(S, { a: 1, b: 2, c: "x" }, { a: 1, b: 0x0304, c: "x" })).toEqual(bytes(0b010, 3, 4));
    expect(encodeDelta(S, { a: 1, b: 2, c: "x" }, { a: 5, b: 2, c: "yz" })).toEqual(bytes(0b101, 5, 2, 0x79, 0x7a));
  });

  it("uses a second change-bitmask byte from the ninth field on", () => {
    const S = schema({
      f0: uint8,
      f1: uint8,
      f2: uint8,
      f3: uint8,
      f4: uint8,
      f5: uint8,
      f6: uint8,
      f7: uint8,
      f8: uint8,
    });
    const prev = { f0: 0, f1: 1, f2: 2, f3: 3, f4: 4, f5: 5, f6: 6, f7: 7, f8: 8 };
    const delta = encodeDelta(S, prev, { ...prev, f8: 80 });
    expect(delta).toEqual(bytes(0, 1, 80));
    if (delta === null) return;
    expect(applyDelta(S, prev, delta)).toEqual({ ...prev, f8: 80 });
    expect(applyDelta(S, prev, atOffset(delta))).toEqual({ ...prev, f8: 80 });
  });

  it("writes a null bitmask over every nullable field after the change bitmask", () => {
    const S = schema({ name: nullable(string), count: uint32, score: nullable(uint32) });
    expect(encodeDelta(S, { name: "al", count: 5, score: 42 }, { name: null, count: 6, score: 42 })).toEqual(
      bytes(0b011, 0b01, 0, 0, 0, 6),
    );
    // unchanged null fields still set their null bit
    expect(encodeDelta(S, { name: null, count: 5, score: null }, { name: null, count: 6, score: null })).toEqual(
      bytes(0b010, 0b11, 0, 0, 0, 6),
    );
    // a non-null nullable value follows in place
    expect(encodeDelta(S, { name: null, count: 5, score: null }, { name: null, count: 5, score: 1 })).toEqual(
      bytes(0b100, 0b01, 0, 0, 0, 1),
    );
  });

  it("encodes changed nested schemas and arrays like encode does", () => {
    const S = schema({ p: schema({ x: uint8, y: uint16 }), l: array(array(uint8)) });
    const prev = { p: { x: 1, y: 2 }, l: [] };
    const next = { p: { x: 3, y: 4 }, l: [[7]] };
    const delta = encodeDelta(S, prev, next);
    expect(delta).toEqual(bytes(0b11, 3, 0, 4, 1, 1, 7));
    if (delta === null) return;
    expect(applyDelta(S, prev, delta)).toEqual(next);
  });

  it("encodes non-null nullable arrays and schemas", () => {
    const T = schema({ l: nullable(array(uint8)), p: nullable(schema({ x: uint8 })) });
    const prev = { l: null, p: null };
    const next = { l: [5], p: { x: 7 } };
    const delta = encodeDelta(T, prev, next);
    expect(delta).toEqual(bytes(0b11, 0, 1, 5, 7));
    if (delta === null) return;
    expect(applyDelta(T, prev, delta)).toEqual(next);
    expect(applyDelta(T, next, bytes(0b11, 0b11))).toEqual(prev);
  });

  it("writes zero values for missing fields", () => {
    const S = schema({ f: float32, s: string, l: array(uint8) });
    expect(encodeDelta(S, untyped('{"f":1,"s":"a","l":[1]}'), untyped("{}"))).toEqual(bytes(0b111, 0, 0, 0, 0, 0, 0));
  });
});

describe("applyDelta", () => {
  const S = schema({ a: uint8, b: nullable(uint8), c: string, d: nullable(string) });

  it("keeps unchanged fields and does not mutate the current value", () => {
    const current = { a: 1, b: 2, c: "x", d: null };
    const frozen = Object.freeze({ ...current });
    const result = applyDelta(S, frozen, bytes(0b0001, 0b10, 9));
    expect(result).toEqual({ a: 9, b: 2, c: "x", d: null });
    expect(frozen).toEqual(current);
  });

  it("only applies a null bit when the field's change bit is set", () => {
    const current = { a: 1, b: 2, c: "x", d: "y" };
    // b is unchanged although its null bit is set; d changes to null
    expect(applyDelta(S, current, bytes(0b1000, 0b11))).toEqual({ a: 1, b: 2, c: "x", d: null });
  });

  it("reads a changed non-null nullable value after the bitmasks", () => {
    const current = { a: 1, b: null, c: "x", d: null };
    expect(applyDelta(S, current, bytes(0b1010, 0b00, 4, 1, 0x7a))).toEqual({ a: 1, b: 4, c: "x", d: "z" });
  });

  it("finds the null bit of the ninth nullable field in the second byte", () => {
    const N = schema({
      n0: nullable(uint8),
      n1: nullable(uint8),
      n2: nullable(uint8),
      n3: nullable(uint8),
      n4: nullable(uint8),
      n5: nullable(uint8),
      n6: nullable(uint8),
      n7: nullable(uint8),
      n8: nullable(uint8),
    });
    const prev = { n0: 0, n1: 1, n2: 2, n3: 3, n4: 4, n5: 5, n6: 6, n7: 7, n8: 8 };
    const next = { ...prev, n0: null, n8: null };
    const delta = encodeDelta(N, prev, next);
    expect(delta).toEqual(bytes(0b1, 0b1, 0b1, 0b1));
    if (delta === null) return;
    expect(applyDelta(N, prev, delta)).toEqual(next);
    const back = encodeDelta(N, next, prev);
    if (back === null) throw new Error("expected a delta");
    expect(applyDelta(N, next, back)).toEqual(prev);
  });
});

describe("encodeDelta — mixed types", () => {
  it("treats a string becoming a number as a change", () => {
    const S = schema({ s: string });
    expect(encodeDelta(S, untyped('{"s":"1"}'), untyped('{"s":1}'))).not.toBeNull();
  });
});
