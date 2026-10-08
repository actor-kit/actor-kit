/**
 * appendJournalEvent on real SQLite (node:sqlite): the event is written under the transition's
 * seq, a checkpoint every `checkpointEvery`, and pruning keeps everything after the newest
 * checkpoint at least `keep` events old (ADR-013, ADR-015 D1).
 */
import {
  ACTOR_KIT_MIGRATIONS,
  appendJournalEvent,
  type JournalDraft,
  readJournal,
  resolveJournalConfig,
} from "@actor-kit/worker/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSql, type NodeSql } from "./helpers/node-sql";

let sql: NodeSql;

beforeEach(() => {
  sql = createNodeSql();
  for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
});

afterEach(() => sql.close());

const draft: JournalDraft = {
  causeType: "message",
  name: "INC",
  payload: { by: 1 },
  caller: "u",
  callerType: "user",
  role: "member",
  facts: { now: 5 },
};

function append(seq: number, config = resolveJournalConfig(undefined), overrides: Partial<JournalDraft> = {}) {
  return appendJournalEvent(
    sql,
    config,
    { ...draft, ...overrides },
    {
      seq,
      stateJson: `{"n":${seq}}`,
      checksum: `c${seq}`,
      version: 2,
      now: 1000 + seq,
    },
  );
}

describe("appendJournalEvent", () => {
  it("writes the event under the given seq and returns it", () => {
    expect(append(1)).toBe(1);
    expect(append(7)).toBe(7);
    expect(readJournal(sql).events).toEqual([
      {
        seq: 1,
        causeType: "message",
        name: "INC",
        payload: { by: 1 },
        caller: "u",
        callerType: "user",
        role: "member",
        facts: { now: 5 },
        codeVersion: 2,
        stateChecksum: "c1",
        createdAt: 1001,
      },
      expect.objectContaining({ seq: 7, stateChecksum: "c7", createdAt: 1007 }),
    ]);
  });

  it("stores an undefined payload as null", () => {
    append(1, undefined, { payload: undefined });
    expect(readJournal(sql).events[0]?.payload).toBeNull();
  });

  it("refuses to reuse a seq", () => {
    append(3);
    expect(() => append(3)).toThrow();
  });

  it("checkpoints the after-state every checkpointEvery events", () => {
    const config = resolveJournalConfig({ checkpointEvery: 2 });
    for (let seq = 1; seq <= 5; seq++) append(seq, config);
    expect(readJournal(sql).checkpoints).toEqual([
      { seq: 2, version: 2, state: '{"n":2}', checksum: "c2" },
      { seq: 4, version: 2, state: '{"n":4}', checksum: "c4" },
    ]);
  });

  it("keeps everything when keep is not set", () => {
    const config = resolveJournalConfig({ checkpointEvery: 2 });
    for (let seq = 1; seq <= 9; seq++) append(seq, config);
    expect(readJournal(sql).events).toHaveLength(9);
  });

  it("with keep, prunes up to the newest checkpoint at least keep events old", () => {
    const config = resolveJournalConfig({ keep: 3, checkpointEvery: 2 });
    for (let seq = 1; seq <= 4; seq++) append(seq, config);
    // seq 4 - keep 3 = 1: no checkpoint at or below 1 yet, nothing pruned.
    expect(readJournal(sql).events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    append(5, config);
    // 5 - 3 = 2: checkpoint 2 is the base; events ≤ 2 go, checkpoint 2 stays.
    const journal = readJournal(sql);
    expect(journal.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(journal.checkpoints.map((c) => c.seq)).toEqual([2, 4]);
    append(6, config);
    append(7, config);
    // 7 - 3 = 4: base 4; checkpoint 2 goes too.
    expect(readJournal(sql).events.map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(readJournal(sql).checkpoints.map((c) => c.seq)).toEqual([4, 6]);
  });
});
