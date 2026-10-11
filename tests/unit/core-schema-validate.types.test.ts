/**
 * StandardSchemaV1 on view schemas: `parse` and `~standard.validate` are typed with the inferred
 * value. Checked by `pnpm typecheck:types`.
 */
import { enumOf, type Infer, int16, nullable, record, schema, string, uint8, union } from "@actor-kit/core";
import { describe, expectTypeOf, it } from "vitest";

const View = schema({
  phase: enumOf(["lobby", "playing"]),
  scores: record(int16),
  card: union("kind", { card: schema({ rank: uint8 }), joker: schema({}) }),
  partner: nullable(string),
});

describe("schema validation types", () => {
  it("parse returns the inferred view", () => {
    expectTypeOf(View.parse).returns.toEqualTypeOf<Infer<typeof View>>();
  });

  it("~standard validates to the inferred view", () => {
    const result = View["~standard"].validate({});
    if (result.issues === undefined) expectTypeOf(result.value).toEqualTypeOf<Infer<typeof View>>();
    expectTypeOf(View["~standard"].vendor).toEqualTypeOf<"actor-kit">();
  });

  it("field types parse to their own value types", () => {
    expectTypeOf(enumOf(["a", "b"]).parse).returns.toEqualTypeOf<"a" | "b">();
    expectTypeOf(nullable(uint8).parse).returns.toEqualTypeOf<number | null>();
    expectTypeOf(record(string).parse).returns.toEqualTypeOf<{ [key: string]: string }>();
  });
});
