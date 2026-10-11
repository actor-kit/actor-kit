/**
 * ADR-019 C: richer view schemas. Byte-level pins for the wire layout of int8/16/32, enumOf/literal,
 * record, union and json (snapshot and delta), plus the errors they raise. Round trips over random
 * values live in core-rich-schemas.property.test.ts; inference in core-rich-schemas.types.test.ts.
 */

import {
  applyDelta,
  array,
  decode,
  encode,
  encodeDelta,
  enumOf,
  float32,
  float64,
  int8,
  int16,
  int32,
  json,
  literal,
  nullable,
  record,
  schema,
  string,
  uint8,
  union,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { valueMetaOf } from "../../packages/core/src/schema";

const bytes = (...b: number[]) => new Uint8Array(b);

/** Runtime data that did not come from typed code (JS callers, persisted state). */
function untyped(text: string) {
  return JSON.parse(text);
}

describe("int8 / int16 / int32", () => {
  it("are fixed-width two's complement, big-endian", () => {
    const S = schema({ a: int8, b: int16, c: int32 });
    expect(encode(S, { a: -1, b: -2, c: -3 })).toEqual(bytes(0xff, 0xff, 0xfe, 0xff, 0xff, 0xff, 0xfd));
    expect(encode(S, { a: 127, b: 0x7fff, c: 0x7fffffff })).toEqual(bytes(0x7f, 0x7f, 0xff, 0x7f, 0xff, 0xff, 0xff));
  });

  it("decode back to signed numbers at both ends of their range", () => {
    const S = schema({ a: int8, b: int16, c: int32 });
    const min = { a: -128, b: -32768, c: -2147483648 };
    const max = { a: 127, b: 32767, c: 2147483647 };
    expect(decode(S, encode(S, min))).toEqual(min);
    expect(decode(S, encode(S, max))).toEqual(max);
  });

  it("are primitives in the field metadata", () => {
    expect(schema({ a: int8, b: int16, c: int32 }).fields).toEqual([
      { name: "a", type: "int8" },
      { name: "b", type: "int16" },
      { name: "c", type: "int32" },
    ]);
  });
});

describe("enumOf / literal", () => {
  it("writes one byte with the value's index", () => {
    const S = schema({ suit: enumOf(["hearts", "spades", "clubs"]) });
    expect(encode(S, { suit: "clubs" })).toEqual(bytes(2));
    expect(decode(S, bytes(1))).toEqual({ suit: "spades" });
  });

  it("accepts numbers and booleans as values", () => {
    const S = schema({ n: enumOf([10, 20, true]) });
    expect(encode(S, { n: true })).toEqual(bytes(2));
    expect(decode(S, bytes(1))).toEqual({ n: 20 });
  });

  it("uses two bytes for more than 256 values", () => {
    const values = Array.from({ length: 300 }, (_, i) => `v${i}`);
    const S = schema({ v: enumOf(values) });
    expect(encode(S, { v: "v299" })).toEqual(bytes(0x01, 0x2b));
    expect(decode(S, bytes(0x01, 0x00))).toEqual({ v: "v256" });
    expect(schema({ v: enumOf(values.slice(0, 256)) }).fields[0]).toMatchObject({ type: "enum" });
    expect(encode(schema({ v: enumOf(values.slice(0, 256)) }), { v: "v255" })).toEqual(bytes(255));
  });

  it("literal takes no bytes and always decodes to its value", () => {
    const S = schema({ kind: literal("card"), n: uint8 });
    expect(encode(S, { kind: "card", n: 7 })).toEqual(bytes(7));
    expect(decode(S, bytes(7))).toEqual({ kind: "card", n: 7 });
  });

  it("rejects a value outside the list when encoding", () => {
    const S = schema({ suit: enumOf(["hearts", "spades"]) });
    expect(() => encode(S, untyped('{"suit":"stars"}'))).toThrow('"stars" is not one of "hearts", "spades"');
  });

  it("rejects an index outside the list when decoding", () => {
    const S = schema({ suit: enumOf(["hearts", "spades"]) });
    expect(() => decode(S, bytes(2))).toThrow("enum index 2 is out of range (2 values)");
  });

  it("needs at least one value and at most 65536", () => {
    expect(() => enumOf(untyped("[]"))).toThrow("enumOf() needs at least one value");
    expect(() => enumOf(Array.from({ length: 65537 }, (_, i) => i))).toThrow("enumOf() takes at most 65536 values");
    expect(() => enumOf(Array.from({ length: 65536 }, (_, i) => i))).not.toThrow();
    expect(() => enumOf(["a", "a"])).toThrow('enumOf() values must be distinct: "a" appears twice');
  });

  it("is described by its values", () => {
    expect(schema({ s: enumOf(["a", "b"]), l: literal(3) }).fields).toEqual([
      { name: "s", type: "enum", values: ["a", "b"] },
      { name: "l", type: "enum", values: [3] },
    ]);
  });
});

describe("record", () => {
  it("keeps a key named __proto__ as an own key", () => {
    const S = schema({ r: record(uint8) });
    const value = { r: Object.fromEntries([["__proto__", 1]]) };
    const decoded = decode(S, encode(S, value));
    expect(Object.keys(decoded.r)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(decoded.r)).toBe(Object.prototype);
    const delta = encodeDelta(S, { r: {} }, value);
    if (delta === null) throw new Error("expected a delta");
    expect(Object.keys(applyDelta(S, { r: {} }, delta).r)).toEqual(["__proto__"]);
  });

  it("writes a count then each key and value in key order", () => {
    const S = schema({ scores: record(uint8) });
    expect(encode(S, { scores: { a: 1, bc: 2 } })).toEqual(bytes(2, 1, 0x61, 1, 2, 0x62, 0x63, 2));
    expect(decode(S, bytes(2, 1, 0x61, 1, 2, 0x62, 0x63, 2))).toEqual({ scores: { a: 1, bc: 2 } });
  });

  it("encodes an empty record as a zero count", () => {
    const S = schema({ scores: record(uint8) });
    expect(encode(S, { scores: {} })).toEqual(bytes(0));
    expect(encode(S, untyped('{"scores":null}'))).toEqual(bytes(0));
  });

  it("is described by its value type", () => {
    expect(schema({ r: record(array(int8)) }).fields).toEqual([
      { name: "r", type: "record", element: { type: "array", element: { type: "int8" } } },
    ]);
  });

  describe("delta", () => {
    const S = schema({ scores: record(uint8) });

    it("sends removed, changed and added keys", () => {
      const prev = { scores: { a: 1, b: 2, c: 3 } };
      const next = { scores: { a: 1, c: 9, d: 4 } };
      const delta = encodeDelta(S, prev, next);
      // change mask, mode 1 (patch), removed [b], changed [c=9], added [d=4]
      expect(delta).toEqual(bytes(0b1, 1, 1, 1, 0x62, 1, 1, 0x63, 9, 1, 1, 0x64, 4));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(S, prev, delta)).toEqual(next);
    });

    it("keeps the next key order: kept keys first, then added ones", () => {
      const prev = { scores: { a: 1, b: 2 } };
      const next = { scores: { b: 2, c: 3 } };
      const delta = encodeDelta(S, prev, next);
      if (delta === null) throw new Error("expected a delta");
      expect(Object.keys(applyDelta(S, prev, delta).scores)).toEqual(["b", "c"]);
    });

    it("sends the whole record when the key order changed", () => {
      const prev = { scores: { a: 1, b: 2 } };
      const next = { scores: { b: 2, a: 1 } };
      const delta = encodeDelta(S, prev, next);
      // change mask, mode 0 (full), then the record as in a snapshot
      expect(delta).toEqual(bytes(0b1, 0, 2, 1, 0x62, 2, 1, 0x61, 1));
      if (delta === null) throw new Error("expected a delta");
      expect(Object.keys(applyDelta(S, prev, delta).scores)).toEqual(["b", "a"]);
    });

    it("sends the whole record when an added key would land before a kept one", () => {
      const prev = { scores: { b: 2 } };
      const next = { scores: { a: 1, b: 2 } };
      const delta = encodeDelta(S, prev, next);
      expect(delta?.[1]).toBe(0);
      if (delta === null) throw new Error("expected a delta");
      expect(Object.keys(applyDelta(S, prev, delta).scores)).toEqual(["a", "b"]);
    });

    it("patches a record that was null as one with every key added", () => {
      const N = schema({ scores: nullable(record(uint8)) });
      const prev = { scores: null };
      const next = { scores: { a: 5 } };
      const delta = encodeDelta(N, prev, next);
      // change mask, null mask (not null), mode 1, no removed, no changed, added [a=5]
      expect(delta).toEqual(bytes(0b1, 0, 1, 0, 0, 1, 1, 0x61, 5));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(N, prev, delta)).toEqual(next);
    });

    it("sends a nested record's changes as a delta of its own", () => {
      const R = schema({ grid: record(record(uint8)) });
      const prev = { grid: { row: { x: 1, y: 2 } } };
      const next = { grid: { row: { x: 1, y: 3 } } };
      const delta = encodeDelta(R, prev, next);
      // mask, patch, 0 removed, 1 changed: "row" -> (patch, 0 removed, 1 changed: y=3, 0 added), 0 added
      expect(delta).toEqual(bytes(0b1, 1, 0, 1, 3, 0x72, 0x6f, 0x77, 1, 0, 1, 1, 0x79, 3, 0, 0));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(R, prev, delta)).toEqual(next);
    });

    it("rejects an unknown mode byte", () => {
      expect(() => applyDelta(S, { scores: {} }, bytes(0b1, 7))).toThrow("record delta mode 7 is not 0 or 1");
    });
  });
});

const Shape = union("kind", {
  circle: schema({ r: uint8 }),
  rect: schema({ w: uint8, h: uint8, label: nullable(string) }),
});

describe("union", () => {
  it("writes the variant index then the variant's fields", () => {
    const S = schema({ shape: Shape });
    expect(encode(S, { shape: { kind: "circle", r: 4 } })).toEqual(bytes(0, 4));
    // rect: index 1, null mask (label null), w, h
    expect(encode(S, { shape: { kind: "rect", w: 2, h: 3, label: null } })).toEqual(bytes(1, 0b1, 2, 3));
    expect(decode(S, bytes(1, 0, 2, 3, 1, 0x78))).toEqual({ shape: { kind: "rect", w: 2, h: 3, label: "x" } });
  });

  it("decodes with the tag first", () => {
    const S = schema({ shape: Shape });
    expect(Object.keys(decode(S, bytes(0, 4)).shape)).toEqual(["kind", "r"]);
  });

  it("rejects an unknown variant when encoding and when decoding", () => {
    const S = schema({ shape: Shape });
    expect(() => encode(S, untyped('{"shape":{"kind":"star"}}'))).toThrow(
      'union "kind": "star" is not one of "circle", "rect"',
    );
    expect(() => encode(S, untyped('{"shape":null}'))).toThrow(
      'union "kind": undefined is not one of "circle", "rect"',
    );
    expect(() => decode(S, bytes(2))).toThrow('union "kind": variant index 2 is out of range (2 variants)');
  });

  it("rejects a variant that declares the tag field, no variants, or more than 256", () => {
    expect(() => union("kind", { a: schema({ kind: uint8 }) })).toThrow(
      'union "kind": variant "a" must not declare the tag field "kind"',
    );
    expect(() => union("kind", {})).toThrow('union "kind" needs at least one variant');
    const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`v${i}`, schema({})]));
    expect(() => union("kind", many)).toThrow('union "kind" takes at most 256 variants');
    const most = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`v${i}`, schema({})]));
    expect(() => union("kind", most)).not.toThrow();
  });

  it("is described by its tag and variants in declaration order", () => {
    const S = schema({ shape: Shape });
    expect(S.fields[0]).toEqual({
      name: "shape",
      type: "union",
      tag: "kind",
      variants: [
        { name: "circle", schema: Shape.variants["circle"] },
        { name: "rect", schema: Shape.variants["rect"] },
      ],
    });
  });

  describe("delta", () => {
    const S = schema({ shape: Shape, n: uint8 });

    it("sends only the changed variant fields when the tag is the same", () => {
      const prev = { shape: { kind: "rect" as const, w: 2, h: 3, label: null }, n: 0 };
      const next = { shape: { kind: "rect" as const, w: 2, h: 5, label: null }, n: 0 };
      const delta = encodeDelta(S, prev, next);
      // top mask (shape), variant 1, variant change mask (h), variant null mask (label null), h=5
      expect(delta).toEqual(bytes(0b01, 1, 0b010, 0b1, 5));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(S, prev, delta)).toEqual(next);
    });

    it("sends the whole variant when the tag changed", () => {
      const prev = { shape: { kind: "circle" as const, r: 4 }, n: 0 };
      const next = { shape: { kind: "rect" as const, w: 2, h: 3, label: "x" }, n: 0 };
      const delta = encodeDelta(S, prev, next);
      expect(delta).toEqual(bytes(0b01, 1, 0, 2, 3, 1, 0x78));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(S, prev, delta)).toEqual(next);
    });

    it("sets a variant field to null through the variant's null mask", () => {
      const prev = { shape: { kind: "rect" as const, w: 2, h: 3, label: "x" }, n: 0 };
      const next = { shape: { kind: "rect" as const, w: 2, h: 3, label: null }, n: 0 };
      const delta = encodeDelta(S, prev, next);
      expect(delta).toEqual(bytes(0b01, 1, 0b100, 0b1));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(S, prev, delta)).toEqual(next);
    });

    it("sends a union inside a record as a variant delta", () => {
      const R = schema({ shapes: record(Shape) });
      const prev = { shapes: { a: { kind: "circle" as const, r: 1 } } };
      const next = { shapes: { a: { kind: "circle" as const, r: 2 } } };
      const delta = encodeDelta(R, prev, next);
      // mask, patch, 0 removed, 1 changed: "a" -> variant 0, mask 0b1, r=2, 0 added
      expect(delta).toEqual(bytes(0b1, 1, 0, 1, 1, 0x61, 0, 0b1, 2, 0));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(R, prev, delta)).toEqual(next);
    });

    it("sends the whole variant when the previous value was null", () => {
      const N = schema({ shape: nullable(Shape) });
      const prev = { shape: null };
      const next = { shape: { kind: "circle" as const, r: 4 } };
      const delta = encodeDelta(N, prev, next);
      expect(delta).toEqual(bytes(0b1, 0, 0, 4));
      if (delta === null) throw new Error("expected a delta");
      expect(applyDelta(N, prev, delta)).toEqual(next);
    });
  });
});

describe("json", () => {
  const Meta = z.object({ tags: z.array(z.string()), seen: z.number() });

  it("writes the JSON text with a varint byte length", () => {
    const S = schema({ meta: json(Meta) });
    const text = '{"tags":["a"],"seen":1}';
    const encoded = encode(S, { meta: { tags: ["a"], seen: 1 } });
    expect(encoded[0]).toBe(text.length);
    expect(new TextDecoder().decode(encoded.subarray(1))).toBe(text);
    expect(decode(S, encoded)).toEqual({ meta: { tags: ["a"], seen: 1 } });
  });

  it("parses the decoded value with the schema", () => {
    const S = schema({ when: json(z.string().transform((s) => s.length)) });
    const encoded = new Uint8Array([5, ...new TextEncoder().encode('"abc"')]);
    expect(decode(S, encoded)).toEqual({ when: 3 });
  });

  it("rejects a decoded value the schema does not accept", () => {
    const S = schema({ meta: json(Meta) });
    const encoded = new Uint8Array([2, ...new TextEncoder().encode("{}")]);
    expect(() => decode(S, encoded)).toThrow();
  });

  it("encodes an undefined value as null", () => {
    const S = schema({ any: json(z.unknown()) });
    expect(encode(S, { any: undefined })).toEqual(bytes(4, 0x6e, 0x75, 0x6c, 0x6c));
  });

  it("sends a change smaller than the float tolerance (only float fields have one)", () => {
    const S = schema({ n: json(z.number()), r: record(json(z.number())) });
    const prev = { n: 0, r: { a: 0 } };
    const next = { n: 1e-9, r: { a: 1e-9 } };
    const delta = encodeDelta(S, prev, next);
    if (delta === null) throw new Error("expected a delta");
    expect(applyDelta(S, prev, delta)).toEqual(next);
  });

  it("is described by its schema", () => {
    expect(schema({ m: json(Meta) }).fields).toEqual([{ name: "m", type: "json", json: Meta }]);
  });
});

describe("float tolerance in deltas", () => {
  it("applies to float32 fields too", () => {
    const S = schema({ f: float32 });
    expect(encodeDelta(S, { f: 1 }, { f: 1 + 5e-7 })).toBeNull();
  });

  it("applies per key inside a record: a float that moved less than 1e-6 is not a changed key", () => {
    const S = schema({ r: record(float32) });
    // The record's JSON changed, so it is patched, with no removed, changed or added keys.
    expect(encodeDelta(S, { r: { a: 1 } }, { r: { a: 1 + 5e-7 } })).toEqual(bytes(0b1, 1, 0, 0, 0));
  });

  it("does not make null equal to a small number", () => {
    const S = schema({ f: nullable(float32), g: nullable(float64) });
    expect(encodeDelta(S, { f: null, g: 0 }, { f: 0, g: 0 })).toEqual(bytes(0b01, 0b00, 0, 0, 0, 0));
    expect(encodeDelta(S, { f: 0, g: 0 }, { f: 0, g: null })).toEqual(bytes(0b10, 0b10));
  });
});

describe("nullable wrappers of the new types", () => {
  it("describe their inner type", () => {
    const S = schema({
      e: nullable(enumOf(["a"])),
      r: nullable(record(uint8)),
      u: nullable(Shape),
      j: nullable(json(z.number())),
      i: nullable(int16),
    });
    expect(S.fields.map((f) => [f.name, f.type, f.innerType])).toEqual([
      ["e", "nullable", "enum"],
      ["r", "nullable", "record"],
      ["u", "nullable", "union"],
      ["j", "nullable", "json"],
      ["i", "nullable", "int16"],
    ]);
  });

  it("are read through the schema that built them", () => {
    const S = schema({ r: nullable(record(uint8)) });
    const [field] = S.fields;
    if (field === undefined) throw new Error("expected a field");
    expect(valueMetaOf(field)).toEqual({ type: "record", element: { type: "uint8" } });
    expect(() => valueMetaOf({ ...field })).toThrow('nullable field "r" was not built by schema()');
  });

  it("round-trip null and non-null values", () => {
    const S = schema({ r: nullable(record(int8)), u: nullable(Shape), e: nullable(enumOf(["a", "b"])) });
    const nulls = { r: null, u: null, e: null };
    const values = { r: { k: -4 }, u: { kind: "circle" as const, r: 1 }, e: "b" as const };
    expect(decode(S, encode(S, nulls))).toEqual(nulls);
    expect(decode(S, encode(S, values))).toEqual(values);
  });
});
