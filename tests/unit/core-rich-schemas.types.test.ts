/**
 * ADR-019 C: `Infer<>` for the richer view schemas. Checked by `pnpm typecheck:types`.
 */

import {
  array,
  enumOf,
  type Infer,
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
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

describe("Infer<> for the richer view schemas", () => {
  it("signed integers are numbers", () => {
    const S = schema({ a: int8, b: int16, c: int32 });
    expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{ a: number; b: number; c: number }>();
  });

  it("enumOf and literal are their literal values", () => {
    const S = schema({ suit: enumOf(["hearts", "spades"]), n: enumOf([1, 2]), kind: literal("card") });
    expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{ suit: "hearts" | "spades"; n: 1 | 2; kind: "card" }>();
  });

  it("record is a string-keyed record of its value type", () => {
    const S = schema({ scores: record(int16), lists: record(array(string)) });
    expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{
      scores: Record<string, number>;
      lists: Record<string, string[]>;
    }>();
  });

  it("union is a discriminated union on its tag", () => {
    const S = schema({
      shape: union("kind", { circle: schema({ r: uint8 }), rect: schema({ w: uint8, label: nullable(string) }) }),
    });
    type Shape = Infer<typeof S>["shape"];
    expectTypeOf<Shape>().toEqualTypeOf<
      { kind: "circle"; r: number } | { kind: "rect"; w: number; label: string | null }
    >();

    const describe = (shape: Shape): string => (shape.kind === "circle" ? `r${shape.r}` : `w${shape.w}`);
    expectTypeOf(describe).returns.toEqualTypeOf<string>();
  });

  it("json is the schema's output type", () => {
    const S = schema({
      meta: json(z.object({ tags: z.array(z.string()) })),
      n: json(z.string().transform((s) => s.length)),
    });
    expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{ meta: { tags: string[] }; n: number }>();
  });

  it("the new types nest and can be nullable", () => {
    const S = schema({
      r: nullable(record(union("t", { a: schema({ e: enumOf(["x", "y"]) }) }))),
      u: nullable(enumOf(["on", "off"])),
      list: array(union("t", { b: schema({ n: int32 }) })),
    });
    expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{
      r: Record<string, { t: "a"; e: "x" | "y" }> | null;
      u: "on" | "off" | null;
      list: { t: "b"; n: number }[];
    }>();
  });

  it("rejects values outside an enum, a missing tag and a wrong variant field", () => {
    const S = schema({
      suit: enumOf(["hearts", "spades"]),
      shape: union("kind", { circle: schema({ r: uint8 }) }),
    });
    // @ts-expect-error "stars" is not a suit
    const a: Infer<typeof S> = { suit: "stars", shape: { kind: "circle", r: 1 } };
    // @ts-expect-error the circle variant has no `w`
    const b: Infer<typeof S> = { suit: "hearts", shape: { kind: "circle", w: 1 } };
    // @ts-expect-error the tag is required
    const c: Infer<typeof S> = { suit: "hearts", shape: { r: 1 } };
    expectTypeOf([a, b, c]).toBeArray();
  });
});
