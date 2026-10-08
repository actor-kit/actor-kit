import {
  ACTOR_KIT_MIGRATIONS,
  cancelUndoneEffects,
  dueExecutions,
  finishAttempt,
  insertExecutions,
  isRunning,
  journalHighWater,
  nextRetryAt,
  nextTransitionSeq,
  outboxFailedEvent,
  readOutboxRows,
  redriveExecution,
  requeueInterrupted,
  startAttempt,
} from "@actor-kit/worker/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSql, type NodeSql } from "./helpers/node-sql";

let sql: NodeSql;

beforeEach(() => {
  sql = createNodeSql();
  for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
});

afterEach(() => sql.close());

function exec(id: string, seq: number, index: number, service = "EMAIL", input: unknown = { to: id }) {
  return { id, seq, index, service, input, createdAt: 1000 };
}

function statusOf(id: string) {
  return readOutboxRows(sql).find((row) => row.id === id);
}

describe("outbox store (ADR-015 D1)", () => {
  it("inserts executions as pending with 0 attempts, keyed by effect id", () => {
    insertExecutions(sql, [exec("3:0", 3, 0), exec("3:1", 3, 1, "SMS", { n: 1 })]);
    expect(readOutboxRows(sql)).toEqual([
      {
        id: "3:1",
        service: "SMS",
        payload: '{"n":1}',
        status: "pending",
        attempts: 0,
        createdAt: 1000,
        nextAttemptAt: null,
        lastError: null,
      },
      {
        id: "3:0",
        service: "EMAIL",
        payload: '{"to":"3:0"}',
        status: "pending",
        attempts: 0,
        createdAt: 1000,
        nextAttemptAt: null,
        lastError: null,
      },
    ]);
  });

  it("rejects a second row with the same effect id", () => {
    insertExecutions(sql, [exec("3:0", 3, 0)]);
    expect(() => insertExecutions(sql, [exec("3:0", 3, 0)])).toThrow();
  });

  it("lists newest first by (seq, index) as integers", () => {
    insertExecutions(sql, [exec("9:1", 9, 1), exec("9:10", 9, 10), exec("9:2", 9, 2), exec("10:0", 10, 0)]);
    expect(readOutboxRows(sql).map((r) => r.id)).toEqual(["10:0", "9:10", "9:2", "9:1"]);
  });

  it("due rows are pending ones plus retrying ones whose time has come, oldest first", () => {
    insertExecutions(sql, [exec("2:0", 2, 0), exec("10:0", 10, 0), exec("9:0", 9, 0), exec("9:3", 9, 3)]);
    startAttempt(sql, "9:0");
    finishAttempt(sql, "9:0", { status: "retrying", nextAttemptAt: 500 }, "boom");
    startAttempt(sql, "9:3");
    finishAttempt(sql, "9:3", { status: "retrying", nextAttemptAt: 501 }, "boom");

    expect(dueExecutions(sql, 499).map((r) => r.id)).toEqual(["2:0", "10:0"]);
    expect(dueExecutions(sql, 500).map((r) => r.id)).toEqual(["2:0", "9:0", "10:0"]);
    expect(dueExecutions(sql, 501).map((r) => r.id)).toEqual(["2:0", "9:0", "9:3", "10:0"]);
  });

  it("due rows carry the parsed input, service and attempts", () => {
    insertExecutions(sql, [exec("1:0", 1, 0, "EMAIL", { to: "a", n: [1, 2] })]);
    expect(dueExecutions(sql, 0)).toEqual([
      { id: "1:0", service: "EMAIL", input: { to: "a", n: [1, 2] }, attempts: 0 },
    ]);
  });

  it("startAttempt marks the row running and counts the attempt", () => {
    insertExecutions(sql, [exec("1:0", 1, 0)]);
    expect(startAttempt(sql, "1:0")).toBe(1);
    expect(statusOf("1:0")).toMatchObject({ status: "running", attempts: 1 });
    expect(dueExecutions(sql, Number.MAX_SAFE_INTEGER)).toEqual([]);
    finishAttempt(sql, "1:0", { status: "retrying", nextAttemptAt: 10 }, "x");
    expect(startAttempt(sql, "1:0")).toBe(2);
    expect(statusOf("1:0")).toMatchObject({ status: "running", attempts: 2, nextAttemptAt: null });
  });

  it("finishAttempt records done, retrying (with time and error) and failed (with error)", () => {
    insertExecutions(sql, [exec("1:0", 1, 0), exec("1:1", 1, 1), exec("1:2", 1, 2)]);
    for (const id of ["1:0", "1:1", "1:2"]) startAttempt(sql, id);
    finishAttempt(sql, "1:0", { status: "done" }, null);
    finishAttempt(sql, "1:1", { status: "retrying", nextAttemptAt: 42 }, "timeout");
    finishAttempt(sql, "1:2", { status: "failed" }, "bad input");
    expect(statusOf("1:0")).toMatchObject({ status: "done", attempts: 1, nextAttemptAt: null, lastError: null });
    expect(statusOf("1:1")).toMatchObject({ status: "retrying", attempts: 1, nextAttemptAt: 42, lastError: "timeout" });
    expect(statusOf("1:2")).toMatchObject({
      status: "failed",
      attempts: 1,
      nextAttemptAt: null,
      lastError: "bad input",
    });
  });

  it("nextRetryAt is the earliest retrying row, ignoring other statuses", () => {
    expect(nextRetryAt(sql)).toBeNull();
    insertExecutions(sql, [exec("1:0", 1, 0), exec("1:1", 1, 1), exec("1:2", 1, 2)]);
    expect(nextRetryAt(sql)).toBeNull();
    startAttempt(sql, "1:0");
    finishAttempt(sql, "1:0", { status: "retrying", nextAttemptAt: 900 }, "x");
    startAttempt(sql, "1:1");
    finishAttempt(sql, "1:1", { status: "retrying", nextAttemptAt: 700 }, "x");
    expect(nextRetryAt(sql)).toBe(700);
    startAttempt(sql, "1:1");
    expect(nextRetryAt(sql)).toBe(900);
  });

  it("requeueInterrupted puts rows left running by a crash back to pending", () => {
    insertExecutions(sql, [exec("1:0", 1, 0), exec("1:1", 1, 1)]);
    startAttempt(sql, "1:0");
    startAttempt(sql, "1:1");
    finishAttempt(sql, "1:1", { status: "done" }, null);
    requeueInterrupted(sql);
    expect(statusOf("1:0")).toMatchObject({ status: "pending", attempts: 1 });
    expect(statusOf("1:1")).toMatchObject({ status: "done" });
  });

  it("redrive moves a failed row back to pending under the same effect id, attempts reset", () => {
    insertExecutions(sql, [exec("4:0", 4, 0)]);
    startAttempt(sql, "4:0");
    finishAttempt(sql, "4:0", { status: "failed" }, "boom");
    expect(redriveExecution(sql, "4:0")).toBe(true);
    expect(statusOf("4:0")).toMatchObject({ id: "4:0", status: "pending", attempts: 0, lastError: null });
    expect(dueExecutions(sql, 0).map((r) => r.id)).toEqual(["4:0"]);
  });

  it("redrive refuses rows that are not failed, and unknown ids", () => {
    insertExecutions(sql, [exec("4:0", 4, 0), exec("4:1", 4, 1)]);
    startAttempt(sql, "4:1");
    finishAttempt(sql, "4:1", { status: "done" }, null);
    expect(redriveExecution(sql, "4:0")).toBe(false);
    expect(redriveExecution(sql, "4:1")).toBe(false);
    expect(redriveExecution(sql, "9:9")).toBe(false);
    expect(statusOf("4:1")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("migrations seed snapshots.last_seq from the journal sequence", () => {
    const fresh = createNodeSql();
    const [before, after] = [
      ACTOR_KIT_MIGRATIONS.filter((m) => m.name <= "0009_journal"),
      ACTOR_KIT_MIGRATIONS.filter((m) => m.name > "0009_journal"),
    ];
    for (const m of before) fresh.exec(m.sql);
    fresh.exec("INSERT INTO snapshots (id, version, state) VALUES (1, 1, '{}')");
    for (let i = 0; i < 3; i++) {
      fresh.exec(
        "INSERT INTO events (cause_type, payload, facts, code_version, state_checksum, created_at) VALUES ('message', '{}', '{}', 1, 'x', 0)",
      );
    }
    for (const m of after) fresh.exec(m.sql);
    expect(fresh.exec("SELECT last_seq FROM snapshots").one()).toEqual({ last_seq: 3 });
    fresh.close();
  });
});

describe("journalHighWater", () => {
  it("is 0 for an empty journal and the highest seq ever written otherwise, even after pruning", () => {
    expect(journalHighWater(sql)).toBe(0);
    for (let i = 0; i < 4; i++) {
      sql.exec(
        "INSERT INTO events (cause_type, payload, facts, code_version, state_checksum, created_at) VALUES ('message', '{}', '{}', 1, 'x', 0)",
      );
    }
    expect(journalHighWater(sql)).toBe(4);
    sql.exec("DELETE FROM events WHERE seq >= 3");
    expect(journalHighWater(sql)).toBe(4);
  });
});

describe("nextTransitionSeq", () => {
  const event = () =>
    sql.exec(
      "INSERT INTO events (cause_type, payload, facts, code_version, state_checksum, created_at) VALUES ('message', '{}', '{}', 1, 'x', 0)",
    );

  it("is 1 for a new actor", () => {
    expect(nextTransitionSeq(sql)).toBe(1);
  });

  it("follows snapshots.last_seq (journal: false writes no events)", () => {
    sql.exec("INSERT INTO snapshots (id, version, state, last_seq) VALUES (1, 1, '{}', 7)");
    expect(nextTransitionSeq(sql)).toBe(8);
  });

  it("never reuses a journal seq when the snapshot lags it (written by an older deploy)", () => {
    sql.exec("INSERT INTO snapshots (id, version, state, last_seq) VALUES (1, 1, '{}', 1)");
    for (let i = 0; i < 3; i++) event();
    expect(nextTransitionSeq(sql)).toBe(4);
  });

  it("follows the snapshot when it is ahead of the journal", () => {
    event();
    sql.exec("INSERT INTO snapshots (id, version, state, last_seq) VALUES (1, 1, '{}', 9)");
    expect(nextTransitionSeq(sql)).toBe(10);
  });
});

describe("outboxFailedEvent", () => {
  it("is one wide event with stable fields first and no input payload", () => {
    const event = outboxFailedEvent({
      actorType: "room",
      actorId: "r1",
      effectId: "7:1",
      service: "EMAIL",
      attempts: 3,
      error: "smtp down",
    });
    expect(event).toEqual({
      event: "actor_kit.outbox.failed",
      actorType: "room",
      actorId: "r1",
      kind: "execution",
      service: "EMAIL",
      effectId: "7:1",
      attempts: 3,
      error: "smtp down",
    });
    expect(Object.keys(event).slice(0, 4)).toEqual(["event", "actorType", "actorId", "kind"]);
  });
});

describe("cancelUndoneEffects / isRunning (restore, ADR-015 D3)", () => {
  it("fails pending, retrying and running executions declared after toSeq, with the reason", () => {
    insertExecutions(sql, [
      exec("2:0", 2, 0),
      exec("3:0", 3, 0),
      exec("4:0", 4, 0),
      exec("5:0", 5, 0),
      exec("6:0", 6, 0),
    ]);
    startAttempt(sql, "4:0");
    finishAttempt(sql, "4:0", { status: "retrying", nextAttemptAt: 99 }, "x");
    startAttempt(sql, "5:0");
    startAttempt(sql, "6:0");
    finishAttempt(sql, "6:0", { status: "done" }, null);
    cancelUndoneEffects(sql, 2, "cancelled: the actor was restored to seq 2");
    expect(readOutboxRows(sql).map((r) => [r.id, r.status, r.lastError, r.nextAttemptAt])).toEqual([
      ["6:0", "done", null, null],
      ["5:0", "failed", "cancelled: the actor was restored to seq 2", null],
      ["4:0", "failed", "cancelled: the actor was restored to seq 2", null],
      ["3:0", "failed", "cancelled: the actor was restored to seq 2", null],
      ["2:0", "pending", null, null],
    ]);
  });

  it("fails pending forwards declared after toSeq", () => {
    const forward = (id: string, seq: number, status: string) =>
      sql.exec(
        "INSERT INTO forwards (id, seq, idx, link_name, target_id, message, caller, caller_type, status, attempts, created_at) VALUES (?, ?, 0, 'l', 't', '{}', 'c', 'user', ?, 0, 0)",
        id,
        seq,
        status,
      );
    forward("2:0", 2, "pending");
    forward("3:0", 3, "pending");
    forward("4:0", 4, "done");
    cancelUndoneEffects(sql, 2, "why");
    expect(sql.exec("SELECT id, status FROM forwards ORDER BY seq").toArray()).toEqual([
      { id: "2:0", status: "pending" },
      { id: "3:0", status: "failed" },
      { id: "4:0", status: "done" },
    ]);
  });

  it("isRunning tells whether a try is still the row's current one", () => {
    insertExecutions(sql, [exec("1:0", 1, 0)]);
    expect(isRunning(sql, "1:0")).toBe(false);
    startAttempt(sql, "1:0");
    expect(isRunning(sql, "1:0")).toBe(true);
    cancelUndoneEffects(sql, 0, "restored");
    expect(isRunning(sql, "1:0")).toBe(false);
    expect(isRunning(sql, "9:9")).toBe(false);
  });
});
