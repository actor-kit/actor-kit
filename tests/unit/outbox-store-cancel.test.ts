/** ADR-018 G: the outbox store's interrupted and cancelled executions, on real SQLite. */
import {
  ACTOR_KIT_MIGRATIONS,
  cancelExecutionRows,
  finishAttempt,
  insertExecutions,
  interruptedExecutions,
  STALE_CANCEL_REASON,
  startAttempt,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { createNodeSql } from "./helpers/node-sql";

describe("outbox store: interrupted and cancelled executions", () => {
  function store() {
    const sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
    insertExecutions(sql, [
      { id: "1:0", seq: 1, index: 0, service: "a", input: { n: 1 }, createdAt: 0 },
      { id: "2:0", seq: 2, index: 0, service: "b", input: null, createdAt: 0 },
      { id: "10:0", seq: 10, index: 0, service: "c", input: 3, createdAt: 0 },
    ]);
    return sql;
  }
  const status = (sql: ReturnType<typeof store>) =>
    sql.exec("SELECT id, status, last_error FROM executions ORDER BY seq").toArray();

  it("interruptedExecutions lists running rows, oldest effect first, with parsed input and attempts", () => {
    const sql = store();
    startAttempt(sql, "10:0");
    startAttempt(sql, "1:0");
    expect(interruptedExecutions(sql)).toEqual([
      { id: "1:0", service: "a", input: { n: 1 }, attempts: 1 },
      { id: "10:0", service: "c", input: 3, attempts: 1 },
    ]);
  });

  it("cancelExecutionRows cancels unfinished rows and returns their ids; finished or unknown ones are left", () => {
    const sql = store();
    startAttempt(sql, "2:0");
    finishAttempt(sql, "10:0", { status: "done" }, null);
    expect(cancelExecutionRows(sql, ["1:0", "2:0", "10:0", "9:9"])).toEqual(["1:0", "2:0"]);
    expect(status(sql)).toEqual([
      { id: "1:0", status: "cancelled", last_error: "cancelled by ctx.cancel()" },
      { id: "2:0", status: "cancelled", last_error: "cancelled by ctx.cancel()" },
      { id: "10:0", status: "done", last_error: null },
    ]);
  });
});

describe("outbox store: calls cancelled because their state was left (ADR-019 B)", () => {
  it("cancelExecutionRows takes the reason it records", () => {
    const sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
    insertExecutions(sql, [{ id: "1:0", seq: 1, index: 0, service: "a", input: null, createdAt: 0 }]);
    expect(cancelExecutionRows(sql, ["1:0"], STALE_CANCEL_REASON)).toEqual(["1:0"]);
    expect(sql.exec("SELECT status, last_error FROM executions").toArray()).toEqual([
      {
        status: "cancelled",
        last_error: "cancelled: the state that made the call was left (a late result goes to onStale)",
      },
    ]);
  });
});

describe("outbox store: a row cancelled after the drain listed it is not started", () => {
  it("startAttempt starts only pending or retrying rows (null otherwise)", () => {
    const sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
    insertExecutions(sql, [
      { id: "1:0", seq: 1, index: 0, service: "a", input: null, createdAt: 0 },
      { id: "1:1", seq: 1, index: 1, service: "a", input: null, createdAt: 0 },
    ]);
    cancelExecutionRows(sql, ["1:0"]);
    expect(startAttempt(sql, "1:0")).toBeNull();
    expect(startAttempt(sql, "1:1")).toBe(1);
    expect(startAttempt(sql, "1:1")).toBeNull();
    expect(sql.exec("SELECT id, status, attempts FROM executions ORDER BY idx").toArray()).toEqual([
      { id: "1:0", status: "cancelled", attempts: 0 },
      { id: "1:1", status: "running", attempts: 1 },
    ]);
  });
});
