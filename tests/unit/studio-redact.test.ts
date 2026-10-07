import { describe, expect, it } from "vitest";
import { compileRedaction, REDACTED } from "../../packages/worker/src/runtime/studio-redact";

const state = {
  round: 3,
  players: [
    { id: "p1", name: "Juneau", score: 4, contact: { email: "a@x.com" } },
    { id: "p2", name: "Sis", score: 2, contact: { email: "b@x.com" } },
  ],
  host: { name: "Jon", email: "jon@x.com" },
  kids: ["Juneau", "Sis"],
};

describe("compileRedaction", () => {
  it("is a no-op without patterns and returns equal data", () => {
    expect(compileRedaction(undefined).apply(state)).toEqual(state);
    expect(compileRedaction([]).apply(state)).toEqual(state);
    expect(compileRedaction([]).active).toBe(false);
  });

  it("redacts an exact path", () => {
    const out = compileRedaction(["host.name"]).apply(state);
    expect(out).toEqual({ ...state, host: { name: REDACTED, email: "jon@x.com" } });
  });

  it("* matches one key or array index", () => {
    const out = compileRedaction(["players.*.name"]).apply(state);
    expect(out).toMatchObject({
      players: [
        { name: REDACTED, score: 4 },
        { name: REDACTED, score: 2 },
      ],
    });
    expect(out).toMatchObject({ host: { name: "Jon" } });
  });

  it("** matches any depth, including zero segments", () => {
    const out = compileRedaction(["**.email"]).apply(state);
    expect(JSON.stringify(out)).not.toContain("@x.com");
    expect(compileRedaction(["**.round"]).apply(state)).toMatchObject({ round: REDACTED });
  });

  it("** in the middle", () => {
    const out = compileRedaction(["players.**.email"]).apply(state);
    expect(out).toMatchObject({ players: [{ contact: { email: REDACTED } }, { contact: { email: REDACTED } }] });
    expect(out).toMatchObject({ host: { email: "jon@x.com" } });
  });

  it("replaces a matched object or array whole", () => {
    const out = compileRedaction(["kids", "host"]).apply(state);
    expect(out).toMatchObject({ kids: REDACTED, host: REDACTED });
  });

  it("matches array indices by number", () => {
    expect(compileRedaction(["kids.1"]).apply(state)).toMatchObject({ kids: ["Juneau", REDACTED] });
  });

  it("redacts any value type, including null and numbers", () => {
    expect(compileRedaction(["a", "b"]).apply({ a: null, b: 7, c: 1 })).toEqual({ a: REDACTED, b: REDACTED, c: 1 });
  });

  it("does not mutate the input", () => {
    const input = structuredClone(state);
    compileRedaction(["players.*.name", "**.email"]).apply(input);
    expect(input).toEqual(state);
  });

  it("leaves primitives and absent paths alone", () => {
    expect(compileRedaction(["a.b"]).apply(5)).toBe(5);
    expect(compileRedaction(["a.b"]).apply({ x: 1 })).toEqual({ x: 1 });
    expect(compileRedaction(["a.b"]).apply({ a: "str" })).toEqual({ a: "str" });
  });

  it("walks Map entries by stringified key and Set members by index", () => {
    const value = { byId: new Map([["p1", { name: "Juneau" }]]), names: new Set(["Juneau"]) };
    const out = compileRedaction(["byId.*.name", "names.*"]).apply(value);
    expect(
      JSON.stringify(out, (_k, v: unknown) =>
        v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v,
      ),
    ).not.toContain("Juneau");
  });

  it("does not treat __proto__ specially", () => {
    const value: unknown = JSON.parse('{"__proto__": {"name": "x"}, "a": 1}');
    const out = compileRedaction(["**.name"]).apply(value);
    expect(JSON.stringify(out)).not.toContain('"x"');
  });

  it.each([[""], ["a..b"], [".a"], ["a."], ["a.b*"], ["*x"], ["a.***"]])("rejects malformed pattern %j", (pattern) => {
    expect(() => compileRedaction([pattern])).toThrow(/studio\.redact/);
  });

  it("redacts the root only for a pattern made of **", () => {
    expect(compileRedaction(["**"]).apply({ a: 1 })).toBe(REDACTED);
  });
});
