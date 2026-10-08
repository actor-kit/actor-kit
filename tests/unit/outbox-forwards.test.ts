/**
 * Forwards in the outbox (ADR-015 D1, extended): the same lifecycle as executions — pending →
 * running → done | retrying | failed (dead letter) → redrive — keyed by the shared effect id.
 */
import {
  ACTOR_KIT_MIGRATIONS,
  cancelUndoneEffects,
  dueForwards,
  finishAttempt,
  insertExecutions,
  insertForwards,
  isRunning,
  nextRetryAt,
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

function fwd(id: string, seq: number, index: number, targetId = "t1", message = { type: "PING", n: seq }) {
  return { id, seq, index, linkName: "room", targetId, message, createdAt: 1000 };
}

const forwardRow = (id: string) => readOutboxRows(sql).find((row) => row.id === id);

describe("forwards store", () => {
  it("inserts forwards as pending with the caller, and lists them as due, oldest effect first", () => {
    insertForwards(sql, [fwd("4:1", 4, 1), fwd("2:0", 2, 0, "t2")], "u1", "user");
    expect(dueForwards(sql, 0)).toEqual([
      {
        id: "2:0",
        linkName: "room",
        targetId: "t2",
        message: '{"type":"PING","n":2}',
        caller: "u1",
        callerType: "user",
      },
      {
        id: "4:1",
        linkName: "room",
        targetId: "t1",
        message: '{"type":"PING","n":4}',
        caller: "u1",
        callerType: "user",
      },
    ]);
  });

  it("a failed try waits as retrying until its time, then is due again", () => {
    insertForwards(sql, [fwd("2:0", 2, 0)], "svc", "service");
    expect(startAttempt(sql, "2:0", "forwards")).toBe(1);
    expect(isRunning(sql, "2:0", "forwards")).toBe(true);
    expect(dueForwards(sql, 0)).toEqual([]);
    finishAttempt(sql, "2:0", { status: "retrying", nextAttemptAt: 5000 }, "unreachable", "forwards");
    expect(isRunning(sql, "2:0", "forwards")).toBe(false);
    expect(dueForwards(sql, 4999)).toEqual([]);
    expect(dueForwards(sql, 5000).map((f) => f.id)).toEqual(["2:0"]);
    expect(forwardRow("2:0")).toMatchObject({
      status: "retrying",
      attempts: 1,
      nextAttemptAt: 5000,
      lastError: "unreachable",
    });
    expect(startAttempt(sql, "2:0", "forwards")).toBe(2);
    expect(forwardRow("2:0")).toMatchObject({ status: "running", nextAttemptAt: null });
  });

  it("the next retry is the earliest across executions and forwards", () => {
    insertExecutions(sql, [{ id: "1:0", seq: 1, index: 0, service: "S", input: {}, createdAt: 0 }]);
    insertForwards(sql, [fwd("2:0", 2, 0)], "u", "user");
    startAttempt(sql, "1:0");
    finishAttempt(sql, "1:0", { status: "retrying", nextAttemptAt: 9000 }, "x");
    expect(nextRetryAt(sql)).toBe(9000);
    startAttempt(sql, "2:0", "forwards");
    finishAttempt(sql, "2:0", { status: "retrying", nextAttemptAt: 7000 }, "y", "forwards");
    expect(nextRetryAt(sql)).toBe(7000);
  });

  it("a crash leaves no forward running: it is pending again", () => {
    insertForwards(sql, [fwd("2:0", 2, 0)], "u", "user");
    startAttempt(sql, "2:0", "forwards");
    requeueInterrupted(sql);
    expect(forwardRow("2:0")).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("a dead-letter forward is redriven under the same effect id; anything else is not", () => {
    insertForwards(sql, [fwd("2:0", 2, 0), fwd("3:0", 3, 0)], "u", "user");
    startAttempt(sql, "2:0", "forwards");
    finishAttempt(sql, "2:0", { status: "failed" }, "gone", "forwards");
    expect(redriveExecution(sql, "3:0", "forwards")).toBe(false);
    expect(redriveExecution(sql, "2:0", "forwards")).toBe(true);
    expect(forwardRow("2:0")).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: null, lastError: null });
  });

  it("Studio's outbox lists forwards beside executions, newest effect first, with their link and target", () => {
    insertExecutions(sql, [{ id: "3:0", seq: 3, index: 0, service: "S", input: { a: 1 }, createdAt: 0 }]);
    insertForwards(sql, [fwd("2:0", 2, 0), fwd("3:1", 3, 1, "t9")], "u", "user");
    expect(readOutboxRows(sql)).toEqual([
      {
        id: "3:1",
        service: "room",
        payload: '{"type":"PING","n":3}',
        status: "pending",
        attempts: 0,
        createdAt: 1000,
        nextAttemptAt: null,
        lastError: null,
        kind: "forward",
        target: "t9",
      },
      {
        id: "3:0",
        service: "S",
        payload: '{"a":1}',
        status: "pending",
        attempts: 0,
        createdAt: 0,
        nextAttemptAt: null,
        lastError: null,
      },
      {
        id: "2:0",
        service: "room",
        payload: '{"type":"PING","n":2}',
        status: "pending",
        attempts: 0,
        createdAt: 1000,
        nextAttemptAt: null,
        lastError: null,
        kind: "forward",
        target: "t1",
      },
    ]);
  });

  it("a restore makes waiting, retrying and in-flight forwards of undone transitions dead letters", () => {
    insertForwards(sql, [fwd("2:0", 2, 0), fwd("5:0", 5, 0), fwd("6:0", 6, 0), fwd("7:0", 7, 0)], "u", "user");
    startAttempt(sql, "6:0", "forwards");
    startAttempt(sql, "7:0", "forwards");
    finishAttempt(sql, "7:0", { status: "retrying", nextAttemptAt: 1 }, "e", "forwards");
    cancelUndoneEffects(sql, 4, "undone by restore");
    expect(readOutboxRows(sql).map((r) => [r.id, r.status, r.lastError])).toEqual([
      ["7:0", "failed", "undone by restore"],
      ["6:0", "failed", "undone by restore"],
      ["5:0", "failed", "undone by restore"],
      ["2:0", "pending", null],
    ]);
  });
});
