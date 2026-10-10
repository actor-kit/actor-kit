/**
 * The actor's SQLite schema (runtime/migrations.ts), applied in order on real SQLite.
 */
import { ACTOR_KIT_MIGRATIONS } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { createNodeSql } from "./helpers/node-sql";

function schemaAfterMigrations() {
  const sql = createNodeSql();
  for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
  const objects = sql
    .exec("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .toArray()
    .map((row) => `${String(row["type"])}:${String(row["name"])}`);
  sql.close();
  return objects;
}

describe("ACTOR_KIT_MIGRATIONS", () => {
  it("are named uniquely, numbered in order (workers-qb tracks them by name)", () => {
    const names = ACTOR_KIT_MIGRATIONS.map((m) => m.name);
    expect(names).toEqual([
      "0001_initial_schema",
      "0002_outbox_indexes",
      "0003_executions",
      "0004_links",
      "0005_forwards",
      "0006_timeline",
      "0007_studio_connections",
      "0008_drop_studio_connections",
      "0009_journal",
      "0010_effect_ids_and_retries",
      "0011_timers",
      "0012_restore",
      "0013_forward_retries",
      "0014_last_error_tag",
    ]);
  });

  it("build the actor's tables and indexes (studio_connections is created, then dropped)", () => {
    expect(schemaAfterMigrations()).toEqual([
      "index:idx_executions_due",
      "index:idx_executions_status",
      "index:idx_forwards_due",
      "index:idx_forwards_status_created",
      "index:idx_outbox_status_created",
      "index:idx_timeline_created",
      "index:idx_timers_due",
      "table:active_links",
      "table:actor_meta",
      "table:events",
      "table:executions",
      "table:forwards",
      "table:journal_checkpoints",
      "table:link_subscribers",
      "table:outbox",
      "table:snapshots",
      "table:timeline",
      "table:timers",
    ]);
  });
});
