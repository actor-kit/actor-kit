import { array, boolean, float32, float64, nullable, schema, string, uint8, uint16, uint32 } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

describe("schema — primitive descriptors", () => {
  it("are frozen primitives named by their wire type", () => {
    const all = { uint8, uint16, uint32, float32, float64, string, boolean };
    for (const [name, descriptor] of Object.entries(all)) {
      expect(descriptor.kind).toBe("primitive");
      expect(descriptor.type).toBe(name);
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });
});

describe("schema — field metadata", () => {
  it("describes arrays of arrays down to the element type", () => {
    const S = schema({ grid: array(array(uint8)) });
    expect(S.fields[0]).toEqual({
      name: "grid",
      type: "array",
      element: { type: "array", element: { type: "uint8" } },
    });
  });

  it("describes nullable primitives, arrays and schemas by their inner type", () => {
    const Inner = schema({ x: uint8 });
    const S = schema({ a: nullable(string), b: nullable(array(uint16)), c: nullable(Inner) });
    expect(S.fields).toEqual([
      { name: "a", type: "nullable", innerType: "string" },
      { name: "b", type: "nullable", innerType: "array", element: { type: "uint16" } },
      { name: "c", type: "nullable", innerType: "schema", schema: Inner },
    ]);
    expect(S.hasNullable).toBe(true);
  });

  it("has no nullable flag without nullable fields", () => {
    expect(schema({ a: uint8, n: schema({ b: nullable(uint8) }) }).hasNullable).toBe(false);
  });
});
