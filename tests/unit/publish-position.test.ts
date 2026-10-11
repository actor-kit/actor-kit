/**
 * ADR-019 E: the last assigned published-event position, kept in `publish_position` (one row).
 * Real SQLite (node:sqlite) with every runtime migration applied.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readPublishPosition, writePublishPosition } from "../../packages/worker/src/runtime/publish";
import { migratedSql } from "./helpers/journal-sql";
import type { NodeSql } from "./helpers/node-sql";

let sql: NodeSql | undefined;
afterEach(() => {
  sql?.close();
  sql = undefined;
});

describe("publish position store", () => {
  it("is 0 before the first published event", () => {
    sql = migratedSql();
    expect(readPublishPosition(sql)).toBe(0);
  });

  it("keeps the last position written, in a single row", () => {
    sql = migratedSql();
    writePublishPosition(sql, 2);
    writePublishPosition(sql, 5);
    expect(readPublishPosition(sql)).toBe(5);
    expect(sql.exec("SELECT COUNT(*) AS n FROM publish_position").toArray()).toEqual([{ n: 1 }]);
  });
});
