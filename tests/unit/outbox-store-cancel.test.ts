/** ADR-018 G: the outbox store's interrupted and cancelled executions, on real SQLite. */
import {
  ACTOR_KIT_MIGRATIONS,
  cancelExecutionRows,
  finishAttempt,
  insertExecutions,
  interruptedExecutions,
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
