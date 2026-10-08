/**
 * The typed version chain (ADR-015 D5): versions: [version(n, Schema, { state, events, rebuild })]
 * replaces `version` + `migrate`. compileVersions() turns it into what the runtime runs.
 */
import { compileVersions, defineActor, toRuntimeDef, version } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

const V1 = z.object({ players: z.array(z.string()) });
const V2 = z.object({ players: z.array(z.object({ id: z.string() })) });
const V3 = z.object({ players: z.array(z.object({ id: z.string(), avatar: z.string().nullable() })) });

const chain = [
  version(1, V1),
  version(2, V2, {
    state: (s: z.infer<typeof V1>) => ({ players: s.players.map((id) => ({ id })) }),
    events: { JOIN: (p) => ({ ...p, avatar: null }) },
  }),
  version(3, V3, {
    state: (s: z.infer<typeof V2>) => ({ players: s.players.map((p) => ({ ...p, avatar: null })) }),
    events: { JOIN: (p) => ({ ...p, source: "v3" }) },
  }),
] as const;

describe("version()", () => {
  it("returns its parts", () => {
    const v = version(2, V2, { rebuild: "replay" });
    expect(v).toEqual({ version: 2, schema: V2, rebuild: "replay" });
    expectTypeOf(v.version).toEqualTypeOf<2>();
  });

  it("types each step against the previous version's state", () => {
    version(2, V2, {
      state: (s: z.infer<typeof V1>) => {
        expectTypeOf(s.players).toEqualTypeOf<string[]>();
        return { players: [] };
      },
    });
  });
});

describe("compileVersions", () => {
  const compiled = compileVersions(chain);

  it("the current version is the last one; every version is known", () => {
    expect(compiled.version).toBe(3);
    expect(compiled.versions).toEqual([1, 2, 3]);
    expect(compiled.rebuildVersion).toBeNull();
  });

  it("migrates persisted state step by step from any older version, parsing each step's output", () => {
    expect(compiled.migrate({ players: ["a"] }, 1)).toEqual({ players: [{ id: "a", avatar: null }] });
    expect(compiled.migrate({ players: [{ id: "b" }] }, 2)).toEqual({ players: [{ id: "b", avatar: null }] });
    expect(compiled.migrate({ players: [{ id: "c", avatar: "x" }] }, 3)).toEqual({
      players: [{ id: "c", avatar: "x" }],
    });
  });

  it("parses the persisted state with the schema of the version that wrote it", () => {
    expect(() => compiled.migrate({ players: [1] }, 1)).toThrow(/version 1/);
  });

  it("refuses a state step whose output does not match its version's schema", () => {
    // The types refuse this step; built by hand to check the runtime refuses it too.
    const bad = compileVersions([version(1, V1), { version: 2, schema: V2, state: () => ({ players: "nope" }) }]);
    expect(() => bad.migrate({ players: [] }, 1)).toThrow(/version 2/);
  });

  it("a step without `state` keeps the state (it must already match)", () => {
    const same = compileVersions([version(1, V1), version(2, V1, { events: { X: (p) => p } })]);
    expect(same.migrate({ players: ["a"] }, 1)).toEqual({ players: ["a"] });
  });

  it("refuses to migrate from an unknown version", () => {
    expect(() => compiled.migrate({}, 7)).toThrow(/no path from version 7 to version 3/);
  });

  it("upcasts a message payload through every later step", () => {
    expect(compiled.upcast("JOIN", { id: "a" }, 1)).toEqual({ id: "a", avatar: null, source: "v3" });
    expect(compiled.upcast("JOIN", { id: "a" }, 2)).toEqual({ id: "a", source: "v3" });
    expect(compiled.upcast("JOIN", { id: "a" }, 3)).toEqual({ id: "a" });
    expect(compiled.upcast("LEAVE", { id: "a" }, 1)).toEqual({ id: "a" });
    expect(compiled.upcast("JOIN", "not a record", 1)).toBe("not a record");
  });

  it("knows the newest version that rebuilds by replay; migrate refuses to cross it", () => {
    const rebuilt = compileVersions([version(1, V1), version(2, V1, { rebuild: "replay" }), version(3, V1)]);
    expect(rebuilt.rebuildVersion).toBe(2);
    expect(() => rebuilt.migrate({ players: [] }, 1)).toThrow(/rebuilds by replay/);
    expect(rebuilt.migrate({ players: [] }, 2)).toEqual({ players: [] });
  });

  it.each([
    ["an empty chain", []],
    ["a non-array", { 1: V1 }],
    ["a version that is not a version()", [{ version: 1 }]],
    ["versions out of order", [version(2, V1), version(1, V1)]],
    ["a repeated version", [version(1, V1), version(1, V1)]],
    ["a non-integer version", [version(1.5, V1)]],
    ["a version below 1", [version(0, V1)]],
    ["a first version with a state step", [version(1, V1, { state: () => ({ players: [] }) })]],
  ])("refuses %s", (_what, bad) => {
    expect(() => compileVersions(bad)).toThrow(/versions/);
  });
});

describe("toRuntimeDef", () => {
  const base = { input: z.object({}), init: () => ({ players: [] }), roles: {}, views: {} };

  it("compiles versions into the runtime's version, migrate and upcast", () => {
    const def = toRuntimeDef({ ...base, versions: chain });
    expect(def.version).toBe(3);
    expect(def.migrate?.({ players: ["a"] }, 1)).toEqual({ players: [{ id: "a", avatar: null }] });
    expect(def.upcast?.("JOIN", {}, 2)).toEqual({ source: "v3" });
    expect(def.knownVersions).toEqual([1, 2, 3]);
  });

  it("leaves a def without versions at version 1", () => {
    const def = toRuntimeDef(base);
    expect(def.version).toBe(1);
    expect(def.migrate).toBeUndefined();
  });

  it.each([
    ["version", { version: 2 }],
    ["migrate", { migrate: (p: unknown) => p }],
  ])("refuses the old %s option: versions replaces it", (_name, old) => {
    expect(() => toRuntimeDef({ ...base, ...old })).toThrow(/versions: \[version\(n, Schema/);
  });

  it("refuses rebuild: replay without the journal", () => {
    expect(() =>
      toRuntimeDef({ ...base, journal: false, versions: [version(1, V1), version(2, V1, { rebuild: "replay" })] }),
    ).toThrow(/needs the journal/);
  });
});

describe("defineActor: the chain is typed", () => {
  it("accepts a chain whose steps follow each other and whose last version matches init", () => {
    defineActor("ok", {
      input: z.object({}),
      init: () => ({ players: [] as { id: string; avatar: string | null }[] }),
      versions: chain,
    });
  });

  it("refuses a step typed against the wrong previous state", () => {
    defineActor("bad-step", {
      input: z.object({}),
      init: () => ({ players: [] as string[] }),
      // @ts-expect-error version 2's state step takes V2, but version 1's state is V1
      versions: [
        version(1, V1),
        version(2, V1, { state: (s: z.infer<typeof V2>) => ({ players: s.players.map((p) => p.id) }) }),
      ],
    });
  });

  it("refuses a chain whose last version does not match what init returns", () => {
    defineActor("bad-last", {
      input: z.object({}),
      init: () => ({ count: 0 }),
      // @ts-expect-error the last version's schema must describe init's state
      versions: [version(1, V1)],
    });
  });
});
