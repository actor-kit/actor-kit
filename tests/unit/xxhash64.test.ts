import { xxh64 } from "@actor-kit/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { referenceXxh64 } from "./fixtures/xxh64-bigint";

// Reference values from the xxhash C library (python-xxhash xxh64, seed 0, UTF-8 input).
describe("xxh64", () => {
  it.each([
    ["", "ef46db3751d8e999"],
    ["a", "d24ec4f1a98c6e5b"],
    ["abc", "44bc2cf5ad770999"],
    ["Nobody inspects the spammish repetition", "fbcea83c8a378bf1"],
    ["The quick brown fox jumps over the lazy dog", "0b242d361fda71bc"],
    ["héllo wörld — ünïcode ☃ 🎲", "9878d55ff6704c3f"],
    ["x".repeat(1000), "4cb9a3b69cb700e1"],
  ])("hashes %j to the reference value", (input, expected) => {
    expect(xxh64(input)).toBe(expected);
  });

  const base = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2);
  // Lengths straddle every branch: 1-byte tail, 4-byte tail, 8-byte lanes, 32-byte stripes.
  it.each([
    [1, "633457081244afec"],
    [3, "1c2dcb4b9024d73d"],
    [4, "4c33072b45647dcb"],
    [5, "34cb4c2ee6166f65"],
    [7, "97ee4fe4a0ff4dfa"],
    [8, "e4ba22a49ad89d3f"],
    [9, "43ecc9248bc07d20"],
    [12, "862e292326b8a4fc"],
    [15, "4bb51a30968e6a4d"],
    [16, "5c5b90c34e376d0b"],
    [17, "8036ee70cd0a1505"],
    [31, "80adfc1d42020f39"],
    [32, "bf7c9dbe16b5c6e2"],
    [33, "e97423e605e2f3b4"],
    [63, "82caa9ab0d6c3044"],
    [64, "763e844e9e2f30a9"],
    [65, "16add03ef51afec7"],
    [100, "477e4b027ef957b3"],
  ])("hashes a %i-byte input to the reference value", (length, expected) => {
    expect(xxh64(base.slice(0, length))).toBe(expected);
  });

  it("always returns 16 lowercase hex characters", () => {
    for (const input of ["", "a", "zz", base]) {
      expect(xxh64(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("xxh64 (32-bit arithmetic) matches the BigInt implementation", () => {
  it("for any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (input) => xxh64(input) === referenceXxh64(input)),
      { numRuns: 2000 },
    );
  });

  it("for long JSON states (the journal checksums whole states)", () => {
    const state = { album: Array.from({ length: 300 }, (_, i) => ({ id: `card_${i}`, shiny: i % 10 === 0 })) };
    const json = JSON.stringify(state);
    expect(xxh64(json)).toBe(referenceXxh64(json));
  });
});
