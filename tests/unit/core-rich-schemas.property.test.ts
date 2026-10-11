/**
 * ADR-019 C: property-based round trips over random schemas (every field type, nested up to three
 * levels) and random values of them:
 *   decode(encode(x)) equals x, and
 *   applyDelta(prev, encodeDelta(prev, next)) equals next,
 * both as values and as JSON text (the client's checksum is xxh64 of the view's JSON, so key order
 * must survive too). Byte layouts are pinned in core-rich-schemas.test.ts.
 */

import {
  applyDelta,
  array,
  boolean,
  decode,
  encode,
  encodeDelta,
  enumOf,
  type FieldDescriptor,
  float32,
  float64,
  int8,
  int16,
  int32,
  json,
  nullable,
  record,
  type SchemaDefinition,
  schema,
  string,
  uint8,
  uint16,
  uint32,
  union,
} from "@actor-kit/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type AnySchema = SchemaDefinition<Record<string, FieldDescriptor>>;

/** A field type with an arbitrary for its values. */
interface Gen {
  readonly descriptor: FieldDescriptor;
  readonly value: fc.Arbitrary<unknown>;
}

interface SchemaGen {
  readonly schema: AnySchema;
  readonly value: fc.Arbitrary<Record<string, unknown>>;
}

/** Floats exact in float32 and far enough apart that the delta's 1e-6 float tolerance never hides a change. */
const exactFloat = fc.integer({ min: -4000, max: 4000 }).map((n) => n / 8);

function primitives(floats: "full" | "exact"): Gen[] {
  const f32 = floats === "full" ? fc.float({ noNaN: true }) : exactFloat;
  const f64 = floats === "full" ? fc.double({ noNaN: true }) : exactFloat;
  return [
    { descriptor: uint8, value: fc.integer({ min: 0, max: 0xff }) },
    { descriptor: uint16, value: fc.integer({ min: 0, max: 0xffff }) },
    { descriptor: uint32, value: fc.integer({ min: 0, max: 0xffffffff }) },
    { descriptor: int8, value: fc.integer({ min: -0x80, max: 0x7f }) },
    { descriptor: int16, value: fc.integer({ min: -0x8000, max: 0x7fff }) },
    { descriptor: int32, value: fc.integer({ min: -0x80000000, max: 0x7fffffff }) },
    { descriptor: float32, value: f32 },
    { descriptor: float64, value: f64 },
    { descriptor: string, value: fc.string({ unit: "grapheme", maxLength: 6 }) },
    { descriptor: boolean, value: fc.boolean() },
    // Through JSON once: jsonValue can produce -0, which JSON text writes as 0.
    { descriptor: json(z.unknown()), value: fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.parse(JSON.stringify(v))) },
  ];
}

const enumGen: fc.Arbitrary<Gen> = fc
  .uniqueArray(fc.oneof(fc.string({ maxLength: 3 }), fc.integer({ min: -3, max: 3 }), fc.boolean()), {
    minLength: 1,
    maxLength: 5,
  })
  .map((values) => ({ descriptor: enumOf(values), value: fc.constantFrom(...values) }));

/** Record keys from a small set (so random prev/next share keys) including prototype names. */
const recordKey = fc.constantFrom("a", "b", "c", "d", "__proto__", "constructor", "");

const FIELD_NAMES = ["f0", "f1", "f2", "f3"];

function schemaGen(gens: readonly Gen[], nullables: readonly boolean[]): SchemaGen {
  const shape: Record<string, FieldDescriptor> = {};
  const values: Record<string, fc.Arbitrary<unknown>> = {};
  gens.forEach((gen, i) => {
    const name = FIELD_NAMES[i] ?? `f${i}`;
    const asNullable = nullables[i] === true && gen.descriptor.kind !== "nullable";
    shape[name] = asNullable ? nullable(baseOf(gen.descriptor)) : gen.descriptor;
    values[name] = asNullable ? fc.option(gen.value, { nil: null }) : gen.value;
  });
  return { schema: schema(shape), value: fc.record(values) };
}

/** Narrows a descriptor that is not nullable (every generated one) for nullable(). */
function baseOf(descriptor: FieldDescriptor) {
  if (descriptor.kind === "nullable") throw new Error("generated nullable(nullable())");
  return descriptor;
}

function fieldGen(depth: number, floats: "full" | "exact"): fc.Arbitrary<Gen> {
  const leaf = fc.oneof(fc.constantFrom(...primitives(floats)), enumGen);
  if (depth === 0) return leaf;
  const inner = fieldGen(depth - 1, floats);
  const nested = fc
    .tuple(fc.array(inner, { minLength: 0, maxLength: 3 }), fc.array(fc.boolean(), { maxLength: 3 }))
    .map(([gens, nullables]) => schemaGen(gens, nullables));
  return fc.oneof(
    { weight: 3, arbitrary: leaf },
    {
      weight: 1,
      arbitrary: inner.map((g) => ({
        descriptor: array(baseOf(g.descriptor)),
        value: fc.array(g.value, { maxLength: 3 }),
      })),
    },
    {
      weight: 1,
      arbitrary: inner.map((g) => ({
        descriptor: record(baseOf(g.descriptor)),
        value: fc.dictionary(recordKey, g.value, { maxKeys: 4 }),
      })),
    },
    { weight: 1, arbitrary: nested.map((s) => ({ descriptor: s.schema, value: s.value })) },
    {
      weight: 1,
      arbitrary: fc.array(nested, { minLength: 1, maxLength: 3 }).map((variants) => {
        const names = variants.map((_, i) => `v${i}`);
        const descriptor = union("tag", Object.fromEntries(variants.map((v, i) => [names[i], v.schema])));
        const value = fc.oneof(...variants.map((v, i) => v.value.map((fields) => ({ tag: names[i], ...fields }))));
        return { descriptor, value };
      }),
    },
  );
}

function viewGen(floats: "full" | "exact"): fc.Arbitrary<SchemaGen> {
  return fc
    .tuple(fc.array(fieldGen(2, floats), { minLength: 1, maxLength: 4 }), fc.array(fc.boolean(), { maxLength: 4 }))
    .map(([gens, nullables]) => schemaGen(gens, nullables));
}

const RUNS = { numRuns: 400 };

describe("decode(encode(x))", () => {
  it("returns x for every type and nesting", () => {
    fc.assert(
      fc.property(
        viewGen("full").chain((g) => fc.tuple(fc.constant(g.schema), g.value)),
        ([S, value]) => {
          const decoded = decode(S, encode(S, value));
          expect(decoded).toEqual(value);
          expect(JSON.stringify(decoded)).toBe(JSON.stringify(value));
        },
      ),
      RUNS,
    );
  });
});

describe("applyDelta(prev, encodeDelta(prev, next))", () => {
  it("returns next for every type and nesting, keeping its JSON text", () => {
    fc.assert(
      fc.property(
        viewGen("exact").chain((g) => fc.tuple(fc.constant(g.schema), g.value, g.value)),
        ([S, prev, next]) => {
          const delta = encodeDelta(S, prev, next);
          const applied = delta === null ? prev : applyDelta(S, prev, delta);
          expect(applied).toEqual(next);
          expect(JSON.stringify(applied)).toBe(JSON.stringify(next));
        },
      ),
      RUNS,
    );
  });

  it("returns next after a chain of deltas starting from a decoded snapshot", () => {
    fc.assert(
      fc.property(
        viewGen("exact").chain((g) =>
          fc.tuple(fc.constant(g.schema), fc.array(g.value, { minLength: 2, maxLength: 5 })),
        ),
        ([S, views]) => {
          const [first, ...rest] = views;
          let current = decode(S, encode(S, first ?? {}));
          for (const next of rest) {
            const delta = encodeDelta(S, current, next);
            current = delta === null ? current : applyDelta(S, current, delta);
            expect(JSON.stringify(current)).toBe(JSON.stringify(next));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
