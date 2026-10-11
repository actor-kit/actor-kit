/**
 * ADR-019 B, edges: a callback runs at the level that owns its call (its ctx.local is that level's
 * merged local, not the leaf's); a callback that changes nothing for a call no state owns is not
 * journaled, one for an owned call is (the id leaves the list); a late result for a service the actor no
 * longer declares changes nothing; a stale call settles once; Studio reads `service.stale` entries.
 */
import { simulate } from "@actor-kit/test";
import { defineActor, phasedState, step, timelineCause } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatCauseSummary } from "../../packages/studio/ui/src/cause-summary";
import { causeLabel } from "../../packages/studio/ui/src/components/actor-detail/timeline-panel";
import { ScopedCalls } from "../integration/src/scoped-calls";

type S = { log: string[] };
const note = (s: S, line: string): S => ({ log: [...s.log, line] });
type Ctx = { local: unknown; execute(service: string, input: unknown, options?: object): string };

/** p (local { k }) makes a scoped call and owns it while its child c (local { j }) is active. */
const Levels = defineActor("levels", {
  input: z.object({}),
  init: (): S => ({ log: [] }),
  roles: { any: () => true },
  views: {},
  initial: "idle",
  messages: {
    FREE: {
      schema: z.object({}),
      handler: (s: S, _p: unknown, ctx: Ctx) => {
        ctx.execute("same", {});
        return s;
      },
    },
    PEEK_FREE: {
      schema: z.object({}),
      handler: (s: S, _p: unknown, ctx: Ctx) => {
        ctx.execute("peek", {});
        return s;
      },
    },
    OWNED: {
      schema: z.object({}),
      handler: (s: S, _p: unknown, ctx: Ctx) => {
        ctx.execute("same", {}, { scope: "state" });
        return s;
      },
    },
  },
  services: {
    peek: {
      fn: async () => null,
      onDone: (s: S, _r: unknown, _i: unknown, ctx: Ctx) => note(s, JSON.stringify(ctx.local)),
    },
    same: { fn: async () => null, onDone: (s: S) => s },
  },
  states: {
    idle: {
      messages: {
        GO: {
          schema: z.object({}),
          handler: (s: S, _p: unknown, ctx: { goto(p: string, s: S): unknown }) => ctx.goto("p", s),
        },
      },
    },
    p: {
      local: z.object({ k: z.number() }),
      initial: "c",
      enter: (_s: S, _i: unknown, ctx: Ctx) => {
        ctx.execute("peek", {}, { scope: "state" });
        return { k: 1 };
      },
      states: {
        c: {
          local: z.object({ j: z.number() }),
          enter: (_s: S, _i: unknown, ctx: Ctx) => {
            ctx.execute("peek", {}, { scope: "state" });
            return { j: 2 };
          },
        },
      },
    },
  },
});

async function levels() {
  const sim = simulate({ contracts: [Levels] });
  const actor = await sim.spawn(Levels, "l", {});
  return { sim, actor };
}

describe("ADR-019 B edges", () => {
  it("a callback runs at the level that owns its call; an unowned one at the leaf", async () => {
    const { sim, actor } = await levels();
    actor.send("u", { type: "GO" });
    expect(phasedState(actor.state).stateTimers).toEqual([["2:0"], ["2:1"]]);
    sim.resolve("2:1", null); // c's call: c's merged local
    sim.resolve("2:0", null); // p's call: p's local only
    actor.send("u", { type: "PEEK_FREE" });
    sim.resolve("5:0", null); // no owner: the leaf's merged local
    expect(phasedState(actor.state)).toMatchObject({
      shared: { log: ['{"k":1,"j":2}', '{"k":1}', '{"k":1,"j":2}'] },
      stateTimers: [[], []],
    });
  });

  it("an unscoped callback that returns the state as it was is not journaled; an owned one is", async () => {
    const { sim, actor } = await levels();
    actor.send("u", { type: "FREE" });
    const before = actor.journal.events.length;
    const state = actor.state;
    sim.resolve(sim.pendingEffects()[0] ?? "", null);
    expect(actor.state).toBe(state);
    expect(actor.journal.events.length).toBe(before);
    actor.send("u", { type: "OWNED" });
    expect(phasedState(actor.state).stateTimers).toEqual([["3:0"]]);
    sim.resolve("3:0", null);
    expect(phasedState(actor.state).stateTimers).toEqual([[]]);
    expect(actor.journal.events.at(-1)).toMatchObject({ causeType: "service.onDone", name: "same" });
  });

  it("a late result settles once", async () => {
    const sim = simulate({ contracts: [ScopedCalls] });
    const actor = await sim.spawn(ScopedCalls, "s", {});
    actor.send("u", { type: "LOAD", q: "x", ms: 1 });
    actor.send("u", { type: "CANCEL" });
    sim.resolve("2:1", { ok: true });
    expect(() => sim.resolve("2:1", { ok: true })).toThrow('No pending effect "2:1"');
    sim.resolve("2:0", { answer: "late", aborted: true });
    expect(sim.pendingEffects()).toEqual([]);
  });

  it("a late result for a service the actor does not declare changes nothing", () => {
    const facts = {
      ctx: { now: () => 0, id: () => "id", random: () => 0 },
      unlinkTargets: () => [],
      recorded: () => ({}),
    };
    const cause = { type: "service.stale", service: "gone", input: null, result: 1, effectId: "1:0" } as const;
    for (const def of [{}, { services: {} }]) {
      const result = step(def, { n: 1 }, cause, facts, {});
      expect(result.state).toEqual({ n: 1 });
      expect(result.alwaysJournal).toBe(true);
      expect(result.event).toMatchObject({ causeType: "service.stale", name: "gone" });
    }
  });

  it("Studio reads service.stale entries", () => {
    const event = {
      seq: 4,
      causeType: "service.stale" as const,
      name: "lookup",
      payload: { input: { q: 1 }, result: { a: 2 }, effectId: "2:0" },
      caller: null,
      callerType: null,
      role: null,
      facts: {},
      codeVersion: 1,
      stateChecksum: "c",
      createdAt: 1,
    };
    expect(timelineCause(event, (l) => l)).toEqual({ service: "lookup", input: { q: 1 }, result: { a: 2 } });
    expect(timelineCause({ ...event, name: null }, (l) => l)).toMatchObject({ service: "unknown" });
    expect(formatCauseSummary("service.stale", { service: "lookup" })).toBe("lookup answered after its state was left");
    expect(causeLabel("service.stale").label).toBe("service late");
  });
});
