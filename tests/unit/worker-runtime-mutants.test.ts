/**
 * Runtime helper edges: which events restore redelivers, restoring to a seq the journal no longer
 * has, lifecycle payloads without callerConnections, link maps, durations and migrations.
 */
import {
  ACTOR_KIT_MIGRATIONS,
  checksumState,
  createLiveFacts,
  hasActorDefShape,
  type JournalEvent,
  parseDuration,
  planRestore,
  type StepFacts,
  step,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type S = { n: number };
const def = {
  init: (): S => ({ n: 0 }),
  messages: { r: { INC: { handler: (s: S) => ({ n: s.n + 1 }) } } },
};

function event(seq: number, n: number, over: Partial<JournalEvent> = {}): JournalEvent {
  return {
    seq,
    causeType: "message",
    name: "INC",
    payload: {},
    caller: "u",
    callerType: "user",
    role: "r",
    facts: {},
    codeVersion: 1,
    stateChecksum: checksumState({}, { n }),
    createdAt: 0,
    ...over,
  };
}
const init = event(1, 0, { causeType: "init", name: null, caller: null, callerType: null, role: null });

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : `non-error: ${String(error)}`;
  }
  return "(no error)";
}

describe("planRestore: edges", () => {
  it("never redelivers a message, even one whose payload names an effect id", async () => {
    const journal = { checkpoints: [], events: [init, event(2, 1), event(3, 2, { payload: { effectId: "2:0" } })] };
    const plan = await planRestore(def, journal, 2);
    expect(plan.redeliver).toEqual([]);
  });

  it("a seq the pruned journal no longer has is refused as pruned", async () => {
    const journal = { checkpoints: [], events: [event(5, 5), event(6, 6)] };
    expect(await failure(() => planRestore(def, journal, 2))).toBe(
      "Cannot restore to seq 2: the journal is pruned before it",
    );
    expect(await failure(() => planRestore({ ...def, version: 1 }, journal, 2))).toBe(
      "Cannot restore to seq 2: the journal is pruned before it",
    );
  });

  it("a seq written by the current version restores", async () => {
    const journal = { checkpoints: [], events: [init, event(2, 1, { codeVersion: 3 })] };
    const plan = await planRestore({ ...def, version: 3, knownVersions: [1, 3] }, journal, 2);
    expect(plan.state).toEqual({ n: 1 });
  });
});

describe("step: lifecycle payload", () => {
  it("has no callerConnections key when the cause has none", () => {
    const live = createLiveFacts({ now: () => 7, id: () => "id-1", random: () => 0.25 });
    const facts: StepFacts = { ctx: live.ctx, unlinkTargets: () => [], recorded: () => live.facts() };
    const result = step(
      {},
      { n: 0 },
      { type: "lifecycle.connect", caller: "b", callerType: "user", role: "u" },
      facts,
      {},
    );
    expect(result.event.payload).toStrictEqual({});
  });
});

describe("hasActorDefShape: links", () => {
  const base = { input: {}, roles: {}, views: {}, init: () => ({}) };
  const link = { contract: {}, onUpdate: () => undefined };

  it("accepts an empty link map", () => {
    expect(hasActorDefShape({ ...base, links: {} })).toBe(true);
  });

  it("refuses a link map with one bad link among good ones", () => {
    expect(hasActorDefShape({ ...base, links: { a: link, b: { contract: {} } } })).toBe(false);
  });
});

describe("parseDuration: units", () => {
  it.each([
    ["5ms", 5],
    ["2s", 2000],
    ["3m", 180_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
    ["1.5s", 1500],
  ])("%s is %i ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });
});

describe("ACTOR_KIT_MIGRATIONS", () => {
  it("every migration carries SQL", () => {
    for (const migration of ACTOR_KIT_MIGRATIONS) expect(migration.sql.trim()).not.toBe("");
  });
});
