/**
 * Version chain edges (ADR-015 D5) that the main versions tests leave open: rebuild + journal
 * combinations, several rebuild versions, state/event steps as functions, schema checks and
 * upcasting through versions without events.
 */
import { compileVersions, toRuntimeDef, version } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const V1 = z.object({ n: z.number() });
const V2 = z.object({ n: z.number(), m: z.number() });

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : `non-error: ${String(error)}`;
  }
  return "(no error)";
}

describe("toRuntimeDef: rebuild and the journal", () => {
  it("a rebuild chain with the journal on (default or explicit) compiles", () => {
    const chain = [version(1, V1), version(2, V1, { rebuild: "replay" })];
    expect(toRuntimeDef({ versions: chain }).rebuildVersion).toBe(2);
    expect(toRuntimeDef({ versions: chain, journal: true }).rebuildVersion).toBe(2);
    expect(toRuntimeDef({ versions: chain, journal: { keep: 10 } }).rebuildVersion).toBe(2);
  });

  it("journal: false without a rebuild compiles", () => {
    const def = toRuntimeDef({ versions: [version(1, V1), version(2, V1)], journal: false });
    expect(def.version).toBe(2);
    expect(def.rebuildVersion).toBeNull();
  });

  it("journal: false with a rebuild is refused", () => {
    const chain = [version(1, V1), version(2, V1, { rebuild: "replay" })];
    expect(failure(() => toRuntimeDef({ versions: chain, journal: false }))).toBe(
      'rebuild: "replay" needs the journal (this actor has journal: false)',
    );
  });
});

describe("compileVersions: chain shape", () => {
  it("with several rebuild versions, the newest wins", () => {
    const chain = [
      version(1, V1),
      version(2, V1, { rebuild: "replay" }),
      version(3, V1),
      version(5, V1, { rebuild: "replay" }),
      version(6, V1),
    ];
    expect(compileVersions(chain).rebuildVersion).toBe(5);
  });

  it("the first version may not step from a previous state", () => {
    const chain = [version(1, V1, { state: () => ({ n: 0 }) }), version(2, V1)];
    expect(failure(() => compileVersions(chain))).toBe(
      "Invalid versions: the first version has no previous state to step from",
    );
  });

  it("the first version may not rebuild by replay", () => {
    const chain = [version(1, V1, { rebuild: "replay" }), version(2, V1)];
    expect(failure(() => compileVersions(chain))).toBe(
      "Invalid versions: the first version has no previous state to step from",
    );
  });

  it("a state step is called with the previous state", () => {
    const chain = [version(1, V1), version(2, V2, { state: (s: { n: number }) => ({ ...s, m: s.n * 2 }) })];
    expect(compileVersions(chain).migrate({ n: 3 }, 1)).toEqual({ n: 3, m: 6 });
  });

  it("a state step or event upcast that is not a function is refused", () => {
    const badState = [
      { version: 1, schema: V1 },
      { version: 2, schema: V1, state: "step" },
    ];
    expect(failure(() => compileVersions(badState))).toMatch(/^Invalid versions: /);
    const badEvent = [
      { version: 1, schema: V1 },
      { version: 2, schema: V1, events: { JOIN: 42 } },
    ];
    expect(failure(() => compileVersions(badEvent))).toMatch(/^Invalid versions: /);
  });

  it.each([
    ["a number", 5],
    ["null", null],
    ["an object without safeParse", {}],
    ["an object whose safeParse is not a function", { safeParse: true }],
  ])("a schema that is %s is refused with a readable message", (_label, schema) => {
    const message = failure(() => compileVersions([{ version: 1, schema }]));
    expect(message).toMatch(/^Invalid versions: /);
    expect(message).toContain("schema must be a Zod schema");
  });
});

describe("compileVersions: upcast", () => {
  const join = (p: Record<string, unknown>) => ({ ...p, avatar: null });

  it("passes through versions that declare no events", () => {
    const chain = [version(1, V1), version(2, V1), version(3, V1, { events: { JOIN: join } })];
    expect(compileVersions(chain).upcast("JOIN", { name: "a" }, 1)).toEqual({ name: "a", avatar: null });
    expect(compileVersions([version(1, V1), version(2, V1)]).upcast("JOIN", { name: "a" }, 1)).toEqual({
      name: "a",
    });
  });

  it("leaves a payload that is not a record alone", () => {
    const compiled = compileVersions([version(1, V1), version(2, V1, { events: { JOIN: join } })]);
    expect(compiled.upcast("JOIN", "raw", 1)).toBe("raw");
    expect(compiled.upcast("JOIN", null, 1)).toBeNull();
    expect(compiled.upcast("JOIN", [1], 1)).toEqual([1]);
  });
});
