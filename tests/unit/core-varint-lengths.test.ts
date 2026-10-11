/**
 * Every length and count on the wire is an unsigned LEB128 varint (7 bits per byte, low bits first,
 * high bit set on every byte but the last): string byte lengths, record keys, json text, array and
 * record counts, and the counts in a record delta. Large values round-trip instead of wrapping a
 * uint16 and corrupting the frame.
 */
import {
  applyDelta,
  array,
  boolean,
  decode,
  encode,
  encodeDelta,
  json,
  record,
  schema,
  string,
  uint8,
} from "@actor-kit/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("varint layout", () => {
  it("writes a short length in one byte", () => {
    expect(encode(schema({ s: string }), { s: "" })).toEqual(bytes(0));
    expect(encode(schema({ s: string }), { s: "hé" })).toEqual(bytes(3, 0x68, 0xc3, 0xa9));
    expect(encode(schema({ l: array(uint8) }), { l: [7, 8] })).toEqual(bytes(2, 7, 8));
  });

  it("uses 7 bits per byte, low bits first", () => {
    const at = (n: number) => encode(schema({ s: string }), { s: "a".repeat(n) }).subarray(0, 3);
    expect(at(127)[0]).toBe(0x7f);
    expect([...at(128).subarray(0, 2)]).toEqual([0x80, 0x01]);
    expect([...at(300).subarray(0, 2)]).toEqual([0xac, 0x02]);
    expect([...at(16384)]).toEqual([0x80, 0x80, 0x01]);
  });

  it("rejects a length that runs past 8 bytes", () => {
    expect(() => decode(schema({ s: string }), new Uint8Array(9).fill(0xff))).toThrow("malformed varint");
    // Eight continuation bytes then a ninth that would end it: still past the limit.
    expect(() => decode(schema({ s: string }), bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01))).toThrow(
      "malformed varint: more than 8 bytes",
    );
    // Eight bytes is the most a length may take.
    const eight = bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00);
    expect(decode(schema({ s: string }), eight)).toEqual({ s: "" });
  });
});

describe("large values round-trip", () => {
  it("a string over 65535 UTF-8 bytes", () => {
    const S = schema({ s: string, after: uint8 });
    const value = { s: "é".repeat(40000), after: 9 };
    expect(decode(S, encode(S, value))).toEqual(value);
  });

  it("an array and a record over 65535 entries, and a long record key", () => {
    const S = schema({ l: array(boolean), r: record(uint8) });
    const value = {
      l: Array.from({ length: 70000 }, (_, i) => i % 2 === 0),
      r: { ...Object.fromEntries(Array.from({ length: 70000 }, (_, i) => [`k${i}`, i % 256])), ["κ".repeat(40000)]: 1 },
    };
    expect(decode(S, encode(S, value))).toEqual(value);
  });

  it("a json value over 65535 bytes", () => {
    const S = schema({ j: json(z.array(z.string())) });
    const value = { j: Array.from({ length: 10000 }, () => "€uro") };
    expect(decode(S, encode(S, value))).toEqual(value);
  });

  it("a record delta with more than 65535 removed, changed and added keys", () => {
    const S = schema({ r: record(uint8) });
    const keys = (prefix: string, n: number, v: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, v]));
    const prev = { r: { ...keys("keep", 70000, 1), ...keys("gone", 70000, 1) } };
    const next = { r: { ...keys("keep", 70000, 2), ...keys("new", 70000, 3) } };
    const delta = encodeDelta(S, prev, next);
    if (delta === null) throw new Error("expected a delta");
    expect(applyDelta(S, prev, delta)).toEqual(next);
  });
});

describe("long and multi-byte strings (property)", () => {
  const S = schema({ s: string, list: array(string), r: record(string) });
  // Long strings: a short random sample (often multi-byte) repeated past 65536 UTF-8 bytes. Cheap to
  // generate, unlike tens of thousands of random graphemes.
  const long = fc
    .tuple(fc.string({ unit: "grapheme", minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 5000 }))
    .map(([sample, extra]) => sample.repeat(Math.ceil(65537 / new TextEncoder().encode(sample).byteLength) + extra));
  const text = fc.oneof(fc.string({ unit: "grapheme", maxLength: 40 }), long);
  const view = fc.record({
    s: text,
    list: fc.array(text, { maxLength: 3 }),
    r: fc.dictionary(fc.string({ unit: "grapheme", maxLength: 300 }), text, { maxKeys: 3 }),
  });

  it("decode(encode(x)) and applyDelta(prev, encodeDelta(prev, next)) return the value", () => {
    fc.assert(
      fc.property(view, view, (prev, next) => {
        expect(decode(S, encode(S, next))).toEqual(next);
        const delta = encodeDelta(S, prev, next);
        expect(delta === null ? prev : applyDelta(S, prev, delta)).toEqual(next);
      }),
      { numRuns: 60 },
    );
  });
});
