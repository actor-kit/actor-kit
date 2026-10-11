/**
 * View schemas validate the decoded JS shape (StandardSchemaV1, `~standard.validate`, plus `parse`):
 * every `schema()` and every field type, with issue paths. Used for boot views a Worker inlines as
 * JSON before `actorClient().create({ initialView })`.
 */
import {
  array,
  boolean,
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
  SchemaValidationError,
  schema,
  string,
  uint8,
  uint16,
  uint32,
  union,
} from "@actor-kit/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

function untyped(text: string): unknown {
  return JSON.parse(text);
}

async function issues(target: { "~standard": { validate(value: unknown): unknown } }, value: unknown) {
  const result = await target["~standard"].validate(value);
  const list = typeof result === "object" && result !== null ? Reflect.get(result, "issues") : undefined;
  return Array.isArray(list) ? list : undefined;
}

const Card = union("kind", {
  card: schema({ suit: enumOf(["hearts", "spades"]), rank: uint8 }),
  joker: schema({}),
});

const Player = schema({
  name: string,
  score: int16,
  ready: boolean,
  hand: array(Card),
  phase: enumOf(["lobby", "playing"]),
  bets: record(uint32),
  partner: nullable(string),
  meta: json(z.object({ tags: z.array(z.string()) })),
});

const good = {
  name: "Juneau",
  score: -3,
  ready: true,
  hand: [{ kind: "card", suit: "hearts", rank: 12 }, { kind: "joker" }],
  phase: "lobby",
  bets: { a: 1 },
  partner: null,
  meta: { tags: ["x"] },
};

describe("schema()['~standard']", () => {
  it("is a StandardSchemaV1 from actor-kit", () => {
    expect(Player["~standard"]).toMatchObject({ version: 1, vendor: "actor-kit" });
  });

  it("accepts a valid value and returns it unchanged", async () => {
    expect(await Player["~standard"].validate(good)).toEqual({ value: good });
    expect(Player.parse(good)).toBe(good);
  });

  it("accepts extra keys (a view may carry its role)", () => {
    expect(Player.parse({ ...good, role: "player" })).toEqual({ ...good, role: "player" });
  });

  it("reports every problem with its path", async () => {
    const bad = {
      ...good,
      name: 5,
      score: 40000,
      hand: [{ kind: "card", suit: "stars", rank: 1 }, { kind: "queen" }],
      phase: "done",
      bets: { a: -1 },
      meta: { tags: [1] },
    };
    expect(await issues(Player, bad)).toEqual([
      { message: "expected a string", path: ["name"] },
      { message: "expected an integer from -32768 to 32767", path: ["score"] },
      { message: 'expected one of "hearts", "spades"', path: ["hand", 0, "suit"] },
      { message: 'expected one of "card", "joker"', path: ["hand", 1, "kind"] },
      { message: 'expected one of "lobby", "playing"', path: ["phase"] },
      { message: "expected an integer from 0 to 4294967295", path: ["bets", "a"] },
      { message: expect.stringContaining("string"), path: ["meta", "tags", 0] },
    ]);
  });

  it("parse throws one error listing the issues", () => {
    expect(() => Player.parse({ ...good, name: 5, partner: 3 })).toThrow(
      "Invalid value: name: expected a string; partner: expected a string or null",
    );
    expect(() => Player.parse(null)).toThrow("Invalid value: (root): expected an object");
  });

  it("reports missing fields", async () => {
    expect(await issues(schema({ n: uint8 }), {})).toEqual([
      { message: "expected an integer from 0 to 255", path: ["n"] },
    ]);
  });
});

describe("field types", () => {
  it.each([
    [uint8, 255, 256],
    [uint8, 0, -1],
    [uint16, 65535, 65536],
    [uint32, 4294967295, 4294967296],
    [int8, -128, -129],
    [int8, 127, 128],
    [int16, -32768, 32768],
    [int32, -2147483648, 2147483648],
    [int32, 0, 1.5],
    [float32, 1.5, "1.5"],
    [float64, -0.25, null],
    [boolean, false, 0],
    [string, "", undefined],
    [literal("x"), "x", "y"],
    [nullable(uint8), null, undefined],
    [array(uint8), [1, 2], [1, "2"]],
    [array(uint8), [], { 0: 1 }],
    [record(boolean), { a: true }, { a: 1 }],
    [record(boolean), {}, []],
    [Card, { kind: "joker" }, { kind: "card", suit: "hearts" }],
    [json(z.number()), 3, "3"],
  ] as const)("%o accepts %j and rejects %j", (type, ok, notOk) => {
    expect(type.parse(ok)).toEqual(ok);
    expect(() => type.parse(notOk)).toThrow("Invalid value");
  });

  it("names the field of a union variant and of a nested schema", async () => {
    expect(await issues(Card, { kind: "card", suit: "hearts", rank: "A" })).toEqual([
      { message: "expected an integer from 0 to 255", path: ["rank"] },
    ]);
    const Outer = schema({ inner: schema({ deep: nullable(array(int8)) }) });
    expect(await issues(Outer, { inner: { deep: [1, 300] } })).toEqual([
      { message: "expected an integer from -128 to 127", path: ["inner", "deep", 1] },
    ]);
    expect(await issues(Card, "joker")).toEqual([{ message: "expected an object", path: [] }]);
  });

  it("rejects strings, arrays and records the wire format cannot hold", async () => {
    expect(await issues(string, "é".repeat(32768))).toEqual([
      { message: "expected a string of at most 65535 UTF-8 bytes", path: [] },
    ]);
    expect(
      await issues(
        array(boolean),
        Array.from({ length: 65536 }, () => true),
      ),
    ).toEqual([{ message: "expected at most 65535 items", path: [] }]);
    const big = Object.fromEntries(Array.from({ length: 65536 }, (_, i) => [`k${i}`, true]));
    expect(await issues(record(boolean), big)).toEqual([{ message: "expected at most 65535 entries", path: [] }]);
    expect(await issues(record(boolean), { ["k".repeat(65536)]: true })).toEqual([
      { message: "expected a key of at most 65535 UTF-8 bytes", path: ["k".repeat(65536)] },
    ]);
    expect(await issues(string, "é".repeat(32767))).toBeUndefined();
  });

  it("accepts the largest string, array, record and key the wire format holds", () => {
    expect(() => string.parse("a".repeat(65535))).not.toThrow();
    expect(() => array(boolean).parse(Array.from({ length: 65535 }, () => true))).not.toThrow();
    const most = Object.fromEntries(Array.from({ length: 65535 }, (_, i) => [`k${i}`, true]));
    expect(() => record(boolean).parse(most)).not.toThrow();
    expect(() => record(boolean).parse({ ["k".repeat(65535)]: true })).not.toThrow();
  });

  it.each([
    [array(uint8), "x", "expected an array"],
    [record(uint8), "x", "expected an object"],
    [float32, "x", "expected a number"],
    [float64, true, "expected a number"],
    [boolean, "x", "expected a boolean"],
    [string, 1, "expected a string"],
    [nullable(uint8), "x", "expected an integer from 0 to 255 or null"],
  ] as const)("%o rejects %j with %j at the root", async (type, value, message) => {
    expect(await issues(type, value)).toEqual([{ message, path: [] }]);
  });

  it("validates nullable elements of an array as their inner type", () => {
    expect(array(nullable(uint8)).parse([1, 2])).toEqual([1, 2]);
  });

  it("throws a SchemaValidationError naming each path and carrying the issues", () => {
    let caught: unknown;
    try {
      Player.parse({ ...good, hand: [{ kind: "card", suit: "stars", rank: 1 }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect(caught).toMatchObject({
      name: "SchemaValidationError",
      message: 'Invalid value: hand.0.suit: expected one of "hearts", "spades"',
      issues: [{ message: 'expected one of "hearts", "spades"', path: ["hand", 0, "suit"] }],
    });
  });

  it("rejects a JSON value read as untyped data", () => {
    expect(() => Player.parse(untyped('{"name":"x"}'))).toThrow("score");
  });
});
