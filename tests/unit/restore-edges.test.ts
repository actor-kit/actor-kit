/**
 * Restore edges (ADR-015 D3): journal ordering and bounds, which recorded results count, checkpoint
 * choice, timer bookkeeping (applyScheduleOps), restore events to the fold's start, timeline seq.
 */

import { xxh64 } from "@actor-kit/core";
import {
  applyScheduleOps,
  checksumState,
  foldEvents,
  type JournalEvent,
  planRestore,
  toTimelineEntry,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

type S = { n: number };
const def = {
  init: (): S => ({ n: 0 }),
  messages: { r: { INC: { handler: (s: S) => ({ n: s.n + 1 }) } } },
  services: { PAY: { onDone: (s: S) => s } },
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
const checkpoint = (seq: number, n: number, timers = "[]") => {
  const state = JSON.stringify({ n });
  return { seq, version: 1, state, checksum: xxh64(state), timers };
};

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : `non-error: ${String(error)}`;
  }
  return "(no error)";
}

describe("planRestore: journal order and bounds", () => {
  it("folds a journal given out of order", async () => {
    const plan = await planRestore(def, { events: [event(3, 2), init, event(2, 1)], checkpoints: [] }, 3);
    expect(plan.state).toEqual({ n: 2 });
  });

  it("says how far the journal runs, also when it is empty", async () => {
    expect(await failure(() => planRestore(def, { events: [], checkpoints: [] }, 1))).toBe(
      "Cannot restore to seq 1: the journal runs from 1 to 0",
    );
    expect(await failure(() => planRestore(def, { events: [init], checkpoints: [] }, 2))).toBe(
      "Cannot restore to seq 2: the journal runs from 1 to 1",
    );
  });

  it("never starts from a checkpoint older than the journal's first event", async () => {
    const pruned = { events: [event(6, 6), event(7, 7)], checkpoints: [checkpoint(2, 2)] };
    expect(await failure(() => planRestore(def, pruned, 7))).toBe(
      "Cannot restore to seq 7: the journal is pruned before it",
    );
  });
});

describe("planRestore: what counts as a recorded result", () => {
  const done = (seq: number, effectId: unknown) =>
    event(seq, 1, {
      causeType: "service.onDone",
      name: "PAY",
      caller: null,
      callerType: null,
      role: null,
      payload: { input: 1, result: 2, effectId },
    });

  it("only service results with a well-formed effect id declared at or before toSeq", async () => {
    const journal = {
      checkpoints: [],
      events: [
        init,
        event(2, 1),
        done(3, "2:0"),
        event(4, 2, { payload: { effectId: "2:0" } }),
        done(5, "not-an-id"),
        done(6, 7),
        done(7, "3:0"),
      ],
    };
    // seq 4 is a message (not a result); seq 5/6 have no usable id; 7:0 was declared at seq 3 > toSeq.
    for (const e of journal.events) if (e.seq >= 3) e.stateChecksum = checksumState({}, { n: e.seq === 3 ? 1 : 2 });
    const plan = await planRestore(def, journal, 2);
    expect(plan.redeliver.map((e) => e.seq)).toEqual([3]);
  });
});

describe("foldEvents: restore events", () => {
  it("a restore event can go back to the fold's starting point", async () => {
    const restoreToStart = event(5, 3, {
      causeType: "restore",
      name: null,
      caller: null,
      callerType: null,
      role: null,
      payload: { toSeq: 3 },
    });
    const points = await foldEvents(def, { seq: 3, point: { state: { n: 3 }, timers: [] } }, [
      event(4, 4),
      restoreToStart,
    ]);
    expect(points.get(5)?.state).toEqual({ n: 3 });
  });
});

describe("applyScheduleOps", () => {
  const schedule = (id: string, key: string, fireAt: number) => {
    const [seq = 0, index = 0] = id.split(":").map(Number);
    return { op: "schedule" as const, id, seq, index, name: "t", key, payload: null, fireAt };
  };

  it("orders by deadline, then seq, then index", () => {
    const timers = applyScheduleOps(
      [],
      [
        schedule("5:1", "e", 10),
        schedule("5:0", "d", 10),
        schedule("3:2", "c", 10),
        schedule("9:0", "b", 5),
        schedule("1:0", "a", 20),
      ],
    );
    expect(timers.map((t) => t.key)).toEqual(["b", "c", "d", "e", "a"]);
  });

  it("replaces by key, cancels by key, and keeps the others", () => {
    const start = applyScheduleOps([], [schedule("1:0", "a", 10), schedule("1:1", "b", 20)]);
    const next = applyScheduleOps(start, [
      schedule("2:0", "a", 30),
      { op: "cancel", key: "b" },
      { op: "cancel", key: "zz" },
    ]);
    expect(next.map((t) => [t.key, t.id, t.fireAt])).toEqual([["a", "2:0", 30]]);
    expect(start.map((t) => t.key)).toEqual(["a", "b"]);
  });
});

describe("toTimelineEntry: journal seq", () => {
  const row = { id: 1, cause_type: "init", cause_data: "{}", state_snapshot: "{}", checksum: "c", created_at: 5 };

  it("carries the seq when the row has one, and leaves it out otherwise", () => {
    expect(toTimelineEntry({ ...row, seq: 7 })).toEqual({
      id: 1,
      causeType: "init",
      causeData: "{}",
      stateSnapshot: "{}",
      checksum: "c",
      createdAt: 5,
      seq: 7,
    });
    expect(toTimelineEntry({ ...row, seq: null })).toStrictEqual({
      id: 1,
      causeType: "init",
      causeData: "{}",
      stateSnapshot: "{}",
      checksum: "c",
      createdAt: 5,
    });
    expect(toTimelineEntry(row)).toStrictEqual({
      id: 1,
      causeType: "init",
      causeData: "{}",
      stateSnapshot: "{}",
      checksum: "c",
      createdAt: 5,
    });
  });

  it("refuses a seq that is not a number", () => {
    expect(() => toTimelineEntry({ ...row, seq: "7" })).toThrow();
  });
});
