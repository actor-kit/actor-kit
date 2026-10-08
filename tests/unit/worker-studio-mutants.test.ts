/**
 * Studio redaction and projection edges (ADR-014): no patterns, values outside every pattern kept
 * by reference, literal segments, many `**` segments, memoized caller hashes, absent cause fields.
 */
import { describe, expect, it } from "vitest";
import { createCallerHasher, projectTimelineEntry } from "../../packages/worker/src/runtime/studio-project";
import { compileRedaction, REDACTED } from "../../packages/worker/src/runtime/studio-redact";

describe("compileRedaction: edges", () => {
  it("without patterns it is inactive and the identity", () => {
    const redactor = compileRedaction(undefined);
    const value = { "Stryker was here": 1 };
    expect(redactor.active).toBe(false);
    expect(redactor.apply(value)).toBe(value);
  });

  it("returns a value outside every pattern as is (same reference)", () => {
    const inner = { x: 1 };
    const list = [1, 2];
    const out = compileRedaction(["a"]).apply({ a: "secret", b: inner, c: list });
    expect(out).toEqual({ a: REDACTED, b: { x: 1 }, c: [1, 2] });
    expect(Reflect.get(Object(out), "b")).toBe(inner);
    expect(Reflect.get(Object(out), "c")).toBe(list);
  });

  it("a literal segment only follows its own key", () => {
    expect(compileRedaction(["a.b"]).apply({ a: { b: 1, c: 2 }, d: { b: 3 } })).toEqual({
      a: { b: REDACTED, c: 2 },
      d: { b: 3 },
    });
  });

  it("stays fast with many ** segments on a deep value", () => {
    let deep: unknown = { zz: "secret" };
    for (let i = 0; i < 300; i++) deep = { k: deep };
    let out = compileRedaction(["**.**.**.**.zz"]).apply(deep);
    for (let i = 0; i < 300; i++) out = Reflect.get(Object(out), "k");
    expect(out).toEqual({ zz: REDACTED });
  });
});

describe("createCallerHasher: memo", () => {
  it("hands back the same pending hash for the same caller", () => {
    const hash = createCallerHasher("test-only-hash-key");
    expect(hash("Juneau")).toBe(hash("Juneau"));
  });
});

describe("projectTimelineEntry: absent value fields", () => {
  it("does not add value fields the cause did not have", async () => {
    const projected = await projectTimelineEntry(
      {
        id: 1,
        causeType: "lifecycle.connect",
        causeData: JSON.stringify({ caller: "u" }),
        stateSnapshot: "{}",
        checksum: "c",
        createdAt: 0,
      },
      { redactor: compileRedaction(["**"]), hashCaller: null },
    );
    expect(JSON.parse(projected.causeData)).toStrictEqual({ caller: "u" });
  });
});
