/**
 * A timer's payload is stored as JSON, where an absent payload becomes null (Catancast,
 * 2026-10-18): the Durable Object parsed that null against `z.object({}).optional()` at fire time
 * and dropped the timer, while simulate() handed the handler the stored null without parsing. Every
 * runtime now fires through the same step core: the stored payload is parsed with the timer's
 * schema, and a stored null is read as absent when the schema rejects null but accepts undefined.
 */
import { schema, uint32, view } from "@actor-kit/core";
import { replayJournal, simulate } from "@actor-kit/test";
import { defineActor, message, timer } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { timerPayload } from "../../packages/worker/src/runtime/timer-payload";

type State = { fired: { name: string; payload: string }[] };
type Ctx = { schedule(name: string, opts: { in?: number; key?: string; payload?: unknown }): void };

const seen = (payload: unknown): string => (payload === undefined ? "undefined" : JSON.stringify(payload));
const fired = (s: State, name: string, payload: unknown): State => ({
  fired: [...s.fired, { name, payload: seen(payload) }],
});

const Timers = defineActor("optional-timers", {
  input: z.object({}),
  init: (): State => ({ fired: [] }),
  roles: { player: () => true },
  messages: {
    LATER: message(
      z.object({
        name: z.enum(["bot", "maybe", "nullish", "plain", "count"]),
        inMs: z.number(),
        payload: z.unknown().optional(),
      }),
      (s: State, { name, inMs, payload }, ctx: Ctx) => {
        ctx.schedule(name, { in: inMs, key: name, ...(payload === undefined ? {} : { payload }) });
        return s;
      },
    ),
  },
  timers: {
    bot: timer(z.object({}).optional(), (s: State, payload) => fired(s, "bot", payload)),
    maybe: timer(z.object({ n: z.number() }).nullable(), (s: State, payload) => fired(s, "maybe", payload)),
    nullish: timer(z.object({ n: z.number() }).nullish(), (s: State, payload) => fired(s, "nullish", payload)),
    plain: timer(z.undefined(), (s: State, payload) => fired(s, "plain", payload)),
    count: timer(z.object({ n: z.number() }), (s: State, payload) => fired(s, "count", payload)),
  },
  views: { player: view.shared(schema({ fired: uint32 }), (s: State) => ({ fired: s.fired.length })) },
});

async function fireOne(name: string, payload?: unknown) {
  const sim = simulate({ contracts: [Timers] });
  const actor = await sim.spawn(Timers, "t1", {});
  expect(
    actor.send("p", { type: "LATER", name, inMs: 10, ...(payload === undefined ? {} : { payload }) }),
  ).toMatchObject({
    ok: true,
  });
  sim.advance("20ms");
  return actor;
}

describe("timer payloads that are optional or nullable (simulate, the step core)", () => {
  it.each([
    ["bot", undefined, "undefined"],
    ["bot", {}, "{}"],
    ["maybe", null, "null"],
    ["maybe", { n: 1 }, '{"n":1}'],
    ["nullish", undefined, "null"],
    ["nullish", null, "null"],
    ["plain", undefined, "undefined"],
    ["count", { n: 2 }, '{"n":2}'],
  ])("%s scheduled with %j: the handler sees %s", async (name, payload, expected) => {
    const actor = await fireOne(name, payload);
    expect(actor.state.fired).toEqual([{ name, payload: expected }]);
  });

  it("the journal replays to the same state", async () => {
    const actor = await fireOne("bot");
    await expect(replayJournal(Timers, actor.journal)).resolves.toMatchObject({ state: actor.state });
  });
});

describe("timerPayload", () => {
  it("returns the schema's parse of the stored payload, not the stored value", () => {
    expect(timerPayload("t", z.object({ n: z.number() }), { n: 1, extra: true })).toEqual({ n: 1 });
  });

  it("reads a stored null as absent only when the schema rejects null", () => {
    expect(timerPayload("t", z.object({}).optional(), null)).toBeUndefined();
    expect(timerPayload("t", z.object({}).nullish(), null)).toBeNull();
  });

  it("a stored value that does not parse is invalid_timer_payload, naming the timer", () => {
    for (const [schema, stored] of [
      [z.object({}).optional(), 5],
      [z.object({ n: z.number() }), null],
      [z.object({ n: z.number() }), { n: "x" }],
    ] as const) {
      expect(() => timerPayload("bot", schema, stored)).toThrow(
        expect.objectContaining({
          code: "invalid_timer_payload",
          message: expect.stringMatching(/^Timer "bot": invalid payload: .+/),
        }),
      );
    }
  });

  it("a schema with a transform applies it once: the handler gets the transformed payload", async () => {
    const Transforming = defineActor("transforming", {
      input: z.object({}),
      init: (): State => ({ fired: [] }),
      roles: { player: () => true },
      messages: {
        LATER: message(z.object({}), (s: State, _p, ctx: Ctx) => {
          ctx.schedule("parsed", { in: 10, payload: "7" });
          return s;
        }),
      },
      timers: {
        // Before, scheduling stored the parse (7) and firing parsed it again: a number fails z.string().
        parsed: timer(z.string().transform(Number), (s: State, payload) => fired(s, "parsed", payload)),
      },
      views: { player: view.shared(schema({ fired: uint32 }), (s: State) => ({ fired: s.fired.length })) },
    });
    const sim = simulate({ contracts: [Transforming] });
    const actor = await sim.spawn(Transforming, "t1", {});
    actor.send("p", { type: "LATER" });
    sim.advance("20ms");
    expect(actor.state.fired).toEqual([{ name: "parsed", payload: "7" }]);
    await expect(replayJournal(Transforming, actor.journal)).resolves.toMatchObject({ state: actor.state });
  });
});
