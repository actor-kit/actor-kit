/**
 * Timers (ADR-015 D2), pure parts: durations, ctx.schedule/ctx.cancel in the step core, the
 * `timer` cause, and the timers table on real SQLite (node:sqlite).
 */
import {
  ACTOR_KIT_MIGRATIONS,
  applyTimerOps,
  createLiveFacts,
  deleteTimer,
  dueTimer,
  earliestDeadline,
  nextTimerAt,
  parseDuration,
  readTimers,
  type StepFacts,
  step,
  timerByKey,
  timerFailedEvent,
} from "@actor-kit/worker/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createNodeSql, type NodeSql } from "./helpers/node-sql";

describe("parseDuration", () => {
  it.each([
    [250, 250],
    [0, 0],
    ["500ms", 500],
    ["30s", 30_000],
    ["1.5s", 1500],
    ["5m", 300_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ])("%j is %d ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "", "5", "s", "5 s", "-5s", "5w", "1e3s", "5sx", "x5s"])(
    "rejects %j",
    (input) => {
      expect(() => parseDuration(input)).toThrow(/duration/);
    },
  );
});

type S = { log: string[] };

function facts(now = 1000): StepFacts {
  const live = createLiveFacts({ now: () => now, id: () => "id", random: () => 0.5 });
  return { ctx: live.ctx, unlinkTargets: () => [], recorded: () => live.facts() };
}

type Ctx = {
  schedule(name: string, opts: { in?: number | string; at?: number; key?: string; payload?: unknown }): void;
  cancel(key: string): void;
  execute(service: string, input: unknown): void;
  lateBy: number;
  key: string;
  env: unknown;
};

const def = {
  roles: { any: () => true },
  timers: {
    roundEnd: {
      schema: z.object({ round: z.number() }),
      handler: (s: S, p: { round: number }, ctx: Ctx) => {
        ctx.execute("SCORE", { round: p.round });
        ctx.schedule("tick", { in: "1s", key: "tick" });
        return { log: [...s.log, `end:${p.round}:${ctx.key}:${ctx.lateBy}`] };
      },
    },
    tick: { schema: z.unknown(), handler: (s: S) => ({ log: [...s.log, "tick"] }) },
  },
  messages: {
    any: {
      START: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: Ctx) => {
          ctx.execute("EMAIL", {});
          ctx.schedule("roundEnd", { in: "30s", key: "round-1", payload: { round: 1 } });
          ctx.schedule("tick", { at: 5000 });
          ctx.cancel("old");
          return s;
        },
      },
      BAD_NAME: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: Ctx) => {
          ctx.schedule("nope", { in: 1 });
          return s;
        },
      },
      BAD_PAYLOAD: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: Ctx) => {
          ctx.schedule("roundEnd", { in: 1, payload: { round: "one" } });
          return s;
        },
      },
      BOTH: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: Ctx) => {
          ctx.schedule("tick", { in: 1, at: 5 });
          return s;
        },
      },
      NEITHER: {
        schema: z.object({}),
        handler: (s: S, _p: unknown, ctx: Ctx) => {
          ctx.schedule("tick", {});
          return s;
        },
      },
    },
  },
};

const message = (name: string) =>
  ({ type: "message", name, payload: {}, caller: "a", callerType: "user", role: "any" }) as const;

describe("ctx.schedule / ctx.cancel in the step core", () => {
  it("records schedules (fire_at = now + in, or at) and cancels, in declaration order, sharing the effect index", () => {
    const { effects } = step(def, { log: [] }, message("START"), facts(1000), {});
    expect(effects.toExecutionEntries(9).map((e) => e.id)).toEqual(["9:0"]);
    expect(effects.toTimerOps(9)).toEqual([
      {
        op: "schedule",
        id: "9:1",
        seq: 9,
        index: 1,
        name: "roundEnd",
        key: "round-1",
        payload: { round: 1 },
        fireAt: 31_000,
      },
      { op: "schedule", id: "9:2", seq: 9, index: 2, name: "tick", key: "9:2", payload: null, fireAt: 5000 },
      { op: "cancel", key: "old" },
    ]);
  });

  it("reads ctx.now() for `in`, so replay computes the same deadline", () => {
    const result = step(def, { log: [] }, message("START"), facts(1000), {});
    expect(result.event.facts).toEqual({ now: 1000 });
  });

  it("refuses an undeclared timer name", () => {
    expect(() => step(def, { log: [] }, message("BAD_NAME"), facts(), {})).toThrow(/Timer "nope" is not declared/);
  });

  it("refuses a payload that does not match the timer's schema", () => {
    expect(() => step(def, { log: [] }, message("BAD_PAYLOAD"), facts(), {})).toThrow(/roundEnd/);
  });

  it("needs exactly one of `in` and `at`", () => {
    expect(() => step(def, { log: [] }, message("BOTH"), facts(), {})).toThrow(/exactly one of/);
    expect(() => step(def, { log: [] }, message("NEITHER"), facts(), {})).toThrow(/exactly one of/);
  });

  it("an actor without a timers block cannot schedule", () => {
    const noTimers = { messages: def.messages };
    expect(() => step(noTimers, { log: [] }, message("START"), facts(), {})).toThrow(/not declared/);
  });

  it("lifecycle handlers can schedule and cancel too", () => {
    const withConnect = {
      ...def,
      lifecycle: {
        connect: (s: S, _e: unknown, ctx: Ctx) => {
          ctx.schedule("tick", { in: 10, key: "k" });
          ctx.cancel("j");
          return s;
        },
      },
    };
    const { effects } = step(
      withConnect,
      { log: [] },
      { type: "lifecycle.connect", caller: "a", callerType: "user", role: "any" },
      facts(100),
      {},
    );
    expect(effects.toTimerOps(2).map((op) => op.op)).toEqual(["schedule", "cancel"]);
  });
});

describe("the timer cause", () => {
  const fire = {
    type: "timer",
    name: "roundEnd",
    id: "4:1",
    key: "round-1",
    payload: { round: 1 },
    fireAt: 31_000,
    lateBy: 250,
  } as const;

  it("runs the timer's handler with key, lateBy, env and the effect verbs; no caller, no role", () => {
    const result = step(def, { log: [] }, fire, facts(31_250), { E: 1 });
    expect(result.state).toEqual({ log: ["end:1:round-1:250"] });
    expect(result.effects.getExecutions()).toEqual([{ service: "SCORE", input: { round: 1 } }]);
    expect(result.effects.toTimerOps(7)).toEqual([
      { op: "schedule", id: "7:1", seq: 7, index: 1, name: "tick", key: "tick", payload: null, fireAt: 32_250 },
    ]);
    expect(result.event).toEqual({
      causeType: "timer",
      name: "roundEnd",
      payload: { id: "4:1", key: "round-1", payload: { round: 1 }, fireAt: 31_000, lateBy: 250 },
      caller: null,
      callerType: null,
      role: null,
      facts: { now: 31_250 },
    });
  });

  it("a timer that is no longer declared leaves the state alone", () => {
    const state = { log: [] };
    expect(step({}, state, fire, facts(), {}).state).toBe(state);
  });

  it("rejects a handler that returns a Promise", () => {
    const asyncTimer = { timers: { roundEnd: { schema: z.unknown(), handler: async (s: S) => s } } };
    expect(() => step(asyncTimer, { log: [] }, fire, facts(), {})).toThrow(/returned a Promise/);
  });
});

describe("timers table", () => {
  let sql: NodeSql;

  beforeEach(() => {
    sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
  });

  afterEach(() => sql.close());

  const schedule = (id: string, key: string, fireAt: number, name = "tick", payload: unknown = { n: id }) => {
    const [seq = 0, index = 0] = id.split(":").map(Number);
    return { op: "schedule" as const, id, seq, index, name, key, payload, fireAt };
  };

  it("stores schedules and lists them by (fire_at, seq, index)", () => {
    applyTimerOps(sql, [schedule("3:0", "a", 500), schedule("2:5", "b", 500), schedule("2:1", "c", 900)], 10);
    expect(readTimers(sql)).toEqual([
      { id: "2:5", name: "tick", key: "b", payload: '{"n":"2:5"}', fireAt: 500, createdAt: 10 },
      { id: "3:0", name: "tick", key: "a", payload: '{"n":"3:0"}', fireAt: 500, createdAt: 10 },
      { id: "2:1", name: "tick", key: "c", payload: '{"n":"2:1"}', fireAt: 900, createdAt: 10 },
    ]);
  });

  it("scheduling an existing key replaces it (debounce)", () => {
    applyTimerOps(sql, [schedule("1:0", "k", 500)], 1);
    applyTimerOps(sql, [schedule("2:0", "k", 800)], 2);
    expect(readTimers(sql).map((t) => [t.id, t.fireAt])).toEqual([["2:0", 800]]);
  });

  it("applies schedules and cancels in order", () => {
    applyTimerOps(sql, [schedule("1:0", "k", 500), { op: "cancel", key: "k" }, schedule("1:2", "j", 600)], 1);
    expect(readTimers(sql).map((t) => t.key)).toEqual(["j"]);
    applyTimerOps(sql, [{ op: "cancel", key: "j" }, schedule("2:1", "j", 700)], 2);
    expect(readTimers(sql).map((t) => t.id)).toEqual(["2:1"]);
    applyTimerOps(sql, [{ op: "cancel", key: "missing" }], 3);
    expect(readTimers(sql)).toHaveLength(1);
  });

  it("dueTimer is the earliest timer due by `now` that was scheduled at or before `maxSeq`", () => {
    applyTimerOps(sql, [schedule("5:0", "late", 100), schedule("2:0", "b", 200), schedule("1:0", "a", 200)], 1);
    expect(dueTimer(sql, 99, 10)).toBeNull();
    expect(dueTimer(sql, 100, 10)).toEqual({
      id: "5:0",
      name: "tick",
      key: "late",
      payload: { n: "5:0" },
      fireAt: 100,
    });
    expect(dueTimer(sql, 100, 4)).toBeNull();
    expect(dueTimer(sql, 500, 4)).toMatchObject({ id: "1:0" });
    deleteTimer(sql, "1:0");
    expect(dueTimer(sql, 500, 4)).toMatchObject({ id: "2:0" });
  });

  it("timerByKey finds one timer by key", () => {
    applyTimerOps(sql, [schedule("1:0", "k", 500, "roundEnd", { round: 2 })], 1);
    expect(timerByKey(sql, "k")).toEqual({ id: "1:0", name: "roundEnd", key: "k", payload: { round: 2 }, fireAt: 500 });
    expect(timerByKey(sql, "nope")).toBeNull();
  });

  it("nextTimerAt is the earliest fire_at, or null", () => {
    expect(nextTimerAt(sql)).toBeNull();
    applyTimerOps(sql, [schedule("1:0", "a", 900), schedule("1:1", "b", 300)], 1);
    expect(nextTimerAt(sql)).toBe(300);
  });
});

describe("earliestDeadline and timerFailedEvent", () => {
  it("picks the earlier deadline, ignoring a missing one", () => {
    expect(earliestDeadline(null, null)).toBeNull();
    expect(earliestDeadline(5, null)).toBe(5);
    expect(earliestDeadline(null, 7)).toBe(7);
    expect(earliestDeadline(9, 7)).toBe(7);
    expect(earliestDeadline(3, 7)).toBe(3);
  });

  it("describes a dropped timer without its payload", () => {
    const due = { id: "4:1", name: "roundEnd", key: "round-1", payload: { secret: "x" }, fireAt: 900 };
    expect(timerFailedEvent("quiz", "q1", due, new Error("bad payload"))).toEqual({
      event: "actor_kit.timer.failed",
      actorType: "quiz",
      actorId: "q1",
      timer: "roundEnd",
      key: "round-1",
      timerId: "4:1",
      fireAt: 900,
      error: "bad payload",
    });
    expect(timerFailedEvent("quiz", "q1", due, "plain").error).toBe("plain");
  });
});
