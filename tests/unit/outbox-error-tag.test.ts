/**
 * The outbox keeps the `_tag` of a row's last error (ADR-016 §2), for Studio's Last error column and the
 * dead-letter wide event. Redrive and restore clear it with the error.
 */
import {
  ACTOR_KIT_MIGRATIONS,
  cancelUndoneEffects,
  finishAttempt,
  insertExecutions,
  insertForwards,
  outboxFailedEvent,
  readOutboxRows,
  redriveExecution,
  startAttempt,
} from "@actor-kit/worker/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSql, type NodeSql } from "./helpers/node-sql";

let sql: NodeSql;

beforeEach(() => {
  sql = createNodeSql();
  for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
  insertExecutions(sql, [{ id: "2:0", seq: 2, index: 0, service: "charge", input: {}, createdAt: 1 }]);
  insertForwards(
    sql,
    [{ id: "3:0", seq: 3, index: 0, linkName: "room", targetId: "r1", message: { type: "PING" }, createdAt: 1 }],
    "u",
    "user",
  );
});

afterEach(() => sql.close());

const row = (id: string) => readOutboxRows(sql).find((r) => r.id === id);

describe("last error tag", () => {
  it("is stored with the error and listed as lastErrorTag, for executions and forwards", () => {
    startAttempt(sql, "2:0");
    finishAttempt(sql, "2:0", { status: "failed" }, '{"_tag":"CardDeclined"}', "executions", "CardDeclined");
    startAttempt(sql, "3:0", "forwards");
    finishAttempt(sql, "3:0", { status: "retrying", nextAttemptAt: 9 }, "unreachable", "forwards", "Defect");
    expect(row("2:0")).toMatchObject({ lastError: '{"_tag":"CardDeclined"}', lastErrorTag: "CardDeclined" });
    expect(row("3:0")).toMatchObject({ lastError: "unreachable", lastErrorTag: "Defect", kind: "forward" });
  });

  it("is absent from rows without one", () => {
    expect(row("2:0")).not.toHaveProperty("lastErrorTag");
    finishAttempt(sql, "2:0", { status: "failed" }, "Service is not defined");
    expect(row("2:0")).not.toHaveProperty("lastErrorTag");
  });

  it("a success clears it", () => {
    finishAttempt(sql, "2:0", { status: "retrying", nextAttemptAt: 1 }, "boom", "executions", "Defect");
    finishAttempt(sql, "2:0", { status: "done" }, null);
    expect(row("2:0")).not.toHaveProperty("lastErrorTag");
  });

  it("redrive clears it", () => {
    finishAttempt(sql, "2:0", { status: "failed" }, "boom", "executions", "Defect");
    finishAttempt(sql, "3:0", { status: "failed" }, "gone", "forwards", "Defect");
    expect(redriveExecution(sql, "2:0")).toBe(true);
    expect(redriveExecution(sql, "3:0", "forwards")).toBe(true);
    expect(row("2:0")).not.toHaveProperty("lastErrorTag");
    expect(row("3:0")).not.toHaveProperty("lastErrorTag");
  });

  it("a restore's cancellation replaces it (its reason is untagged)", () => {
    finishAttempt(sql, "2:0", { status: "retrying", nextAttemptAt: 1 }, "boom", "executions", "Defect");
    finishAttempt(sql, "3:0", { status: "retrying", nextAttemptAt: 1 }, "gone", "forwards", "Defect");
    cancelUndoneEffects(sql, 1, "cancelled");
    expect(row("2:0")).toMatchObject({ status: "failed", lastError: "cancelled" });
    expect(row("2:0")).not.toHaveProperty("lastErrorTag");
    expect(row("3:0")).not.toHaveProperty("lastErrorTag");
  });
});

describe("the dead-letter wide event", () => {
  const fields = {
    actorType: "checkout",
    actorId: "a1",
    effectId: "2:0",
    service: "charge",
    attempts: 1,
    error: '{"_tag":"CardDeclined"}',
  };

  it("carries the error tag when there is one", () => {
    expect(outboxFailedEvent({ ...fields, errorTag: "CardDeclined" })).toEqual({
      event: "actor_kit.outbox.failed",
      kind: "execution",
      ...fields,
      errorTag: "CardDeclined",
    });
  });

  it("leaves it out otherwise", () => {
    expect(outboxFailedEvent(fields)).not.toHaveProperty("errorTag");
  });
});
