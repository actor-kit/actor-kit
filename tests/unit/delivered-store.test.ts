/** ADR-021 spike: the actor's record of delivered client message ids (per caller, bounded). */
import { describe, expect, it } from "vitest";
import { ensureDeliveredTable, recordDelivered, wasDelivered } from "../../packages/worker/src/runtime/delivered-store";
import { createNodeSql } from "./helpers/node-sql";

function store() {
  const sql = createNodeSql();
  ensureDeliveredTable(sql);
  ensureDeliveredTable(sql); // idempotent
  return sql;
}

describe("delivered message ids", () => {
  it("an id is delivered once recorded, per caller", () => {
    const sql = store();
    expect(wasDelivered(sql, "ana", "c:1")).toBe(false);
    recordDelivered(sql, "ana", "c:1", 10);
    expect(wasDelivered(sql, "ana", "c:1")).toBe(true);
    expect(wasDelivered(sql, "bob", "c:1")).toBe(false);
    recordDelivered(sql, "ana", "c:1", 11); // a repeat is ignored
    expect(sql.exec("SELECT COUNT(*) AS n FROM delivered_messages").one()["n"]).toBe(1);
  });

  it("keeps only the most recent ids", () => {
    const sql = store();
    for (let i = 1; i <= 5; i++) recordDelivered(sql, "ana", `c:${i}`, i, 3);
    expect([1, 2, 3, 4, 5].map((i) => wasDelivered(sql, "ana", `c:${i}`))).toEqual([false, false, true, true, true]);
  });
});
