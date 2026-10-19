/**
 * ADR-024: every schema a game hands actor-kit is a Standard Schema. A contract written with zod 3.25
 * (what the games ship to phones) and one hand-rolled validator (no library at all) must define,
 * spawn, take messages, schedule timers and encode JSON view fields exactly as a zod 4 one does.
 */

import { ActorKitError, issuePath, json, parseSchema, type SchemaOutput, schema, uint32, view } from "@actor-kit/core";
import { simulate } from "@actor-kit/test";
import { defineActor, message, timer } from "@actor-kit/worker/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z as z3 } from "zod3";

/** A Standard Schema with no library: a non-empty string. */
const NonEmpty = {
  "~standard": {
    version: 1 as const,
    vendor: "hand-rolled",
    validate: (value: unknown) =>
      typeof value === "string" && value.length > 0
        ? { value }
        : { issues: [{ message: "expected a non-empty string" }] },
    types: undefined as { input: string; output: string } | undefined,
  },
};

/** A message payload validated by hand: `{ text }`, a non-empty string. */
const NotePayload = {
  "~standard": {
    version: 1 as const,
    vendor: "hand-rolled",
    validate: (value: unknown) => {
      const text = typeof value === "object" && value !== null && "text" in value ? value.text : undefined;
      return typeof text === "string" && text.length > 0
        ? { value: { text } }
        : { issues: [{ message: "expected a non-empty string", path: ["text"] }] };
    },
    types: undefined as { input: { text: string }; output: { text: string } } | undefined,
  },
};

/** A Standard Schema whose validator is async (actor-kit's transitions are synchronous). */
const Later = {
  "~standard": {
    version: 1 as const,
    vendor: "hand-rolled",
    validate: async (value: unknown) => ({ value }),
  },
};

describe("parseSchema", () => {
  it("parses with any Standard Schema: zod 3.25 and a hand-rolled one", () => {
    expect(parseSchema(z3.object({ n: z3.number() }), { n: 1 })).toEqual({ success: true, data: { n: 1 } });
    expect(parseSchema(NonEmpty, "hi")).toEqual({ success: true, data: "hi" });
  });

  it("applies the schema's transforms (the output, not the input)", () => {
    const parsed = parseSchema(
      z3.string().transform((s) => s.length),
      "four",
    );
    expect(parsed).toEqual({ success: true, data: 4 });
  });

  it("reports issues with their paths, and the issues as JSON in `message`", () => {
    const parsed = parseSchema(z3.object({ n: z3.number() }), { n: "x" });
    if (parsed.success) throw new Error("expected a failure");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.path).toEqual(["n"]);
    expect(JSON.parse(parsed.message)).toEqual(JSON.parse(JSON.stringify(parsed.issues)));
    const bare = parseSchema(NonEmpty, "");
    expect(bare).toMatchObject({ success: false, issues: [{ message: "expected a non-empty string" }] });
  });

  it("refuses an async validator", () => {
    expect(() => parseSchema(Later, 1)).toThrow(ActorKitError);
    expect(() => parseSchema(Later, 1)).toThrow(/async/);
    try {
      parseSchema(Later, 1);
    } catch (error) {
      expect(error).toMatchObject({ code: "async_schema" });
    }
  });

  it("reads an issue's path as plain keys: none for the value itself, `{ key }` segments unwrapped", () => {
    expect(issuePath({ message: "m" })).toEqual([]);
    expect(issuePath({ message: "m", path: ["a", 0] })).toEqual(["a", 0]);
    expect(issuePath({ message: "m", path: [{ key: "a" }, "b", { key: 1 }] })).toEqual(["a", "b", 1]);
  });

  it("types the output", () => {
    expectTypeOf<SchemaOutput<typeof NonEmpty>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaOutput<ReturnType<typeof z3.number>>>().toEqualTypeOf<number>();
  });
});

const NoteView = schema({ count: uint32, note: json(z3.object({ text: z3.string() })) });

const Counter = defineActor("counter-z3", {
  input: z3.object({ start: z3.number().int() }),
  init: (input) => ({ count: input.start, text: "" }),
  roles: { anyone: () => true },
  messages: {
    ADD: message(z3.object({ by: z3.number().int().positive() }), (state, { by }) => ({
      ...state,
      count: state.count + by,
    })),
    NOTE: message(NotePayload, (state, { text }) => ({ ...state, text })),
    LATER: message(z3.object({ ms: z3.number() }), (state, { ms }, ctx) => {
      ctx.schedule("reset", { in: ms, payload: { to: 0 } });
      return state;
    }),
    BAD_TIMER: message(z3.object({}), (state, _p, ctx) => {
      ctx.schedule("reset", { in: 10, payload: { to: "zero" } });
      return state;
    }),
  },
  timers: {
    reset: timer(z3.object({ to: z3.number() }), (state, { to }) => ({ ...state, count: to })),
  },
  views: {
    anyone: view.shared(NoteView, (s) => ({ count: s.count, note: { text: s.text } })),
  },
});

describe("a contract written with zod 3.25 and a hand-rolled schema", () => {
  const spawn = () => simulate({ contracts: [Counter] }).spawnSync(Counter, "c1", { start: 2 });

  it("spawns from its input, and refuses an input that doesn't parse", () => {
    expect(spawn().state).toEqual({ count: 2, text: "" });
    expect(() => simulate({ contracts: [Counter] }).spawnSync(Counter, "c2", { start: 1.5 })).toThrow(/Invalid input/);
  });

  it("takes valid messages, typed from their schemas", () => {
    const actor = spawn();
    expect(actor.send("u", { type: "ADD", by: 3 })).toEqual({ ok: true });
    expect(actor.send("u", { type: "NOTE", text: "hi" })).toEqual({ ok: true });
    expect(actor.state).toEqual({ count: 5, text: "hi" });
  });

  it("refuses an invalid payload with the schema's issues", () => {
    const actor = spawn();
    const refused = actor.send("u", { type: "ADD", by: -1 });
    expect(refused).toMatchObject({ ok: false, code: "invalid_payload" });
    const empty = actor.send("u", { type: "NOTE", text: "" });
    expect(empty).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(JSON.stringify(empty)).toContain("expected a non-empty string");
    expect(actor.state).toEqual({ count: 2, text: "" });
  });

  it("schedules timers whose payloads parse, and refuses one that doesn't", () => {
    const sim = simulate({ contracts: [Counter] });
    const actor = sim.spawnSync(Counter, "c3", { start: 7 });
    actor.send("u", { type: "LATER", ms: 100 });
    sim.advance("100ms");
    expect(actor.state.count).toBe(0);
    expect(() => actor.send("u", { type: "BAD_TIMER" })).toThrow(/Timer "reset": invalid payload/);
  });

  it("encodes a json() view field checked by its zod 3.25 schema", () => {
    const actor = spawn();
    actor.send("u", { type: "NOTE", text: "hello" });
    expect(actor.view("u")).toEqual({ count: 2, note: { text: "hello" } });
    expect(NoteView["~standard"].validate({ count: 1, note: { text: 5 } }).issues?.[0]?.path).toEqual(["note", "text"]);
  });
});
