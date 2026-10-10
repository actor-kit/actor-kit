/**
 * Write a journal (events + checkpoints, e.g. one simulate() produced) into a migrated node:sqlite
 * database, row for row as the Durable Object stores it, so SQL readers can be tested on it.
 */
import { ACTOR_KIT_MIGRATIONS, type Journal } from "@actor-kit/worker/testing";
import { createNodeSql, type NodeSql } from "./node-sql";

export function migratedSql(): NodeSql {
  const sql = createNodeSql();
  for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
  return sql;
}

export function writeJournal(sql: NodeSql, journal: Journal): void {
  for (const e of journal.events) {
    sql.exec(
      "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      e.seq,
      e.causeType,
      e.name,
      JSON.stringify(e.payload ?? null),
      e.caller,
      e.callerType,
      e.role,
      JSON.stringify(e.facts),
      e.codeVersion,
      e.stateChecksum,
      e.createdAt,
    );
  }
  for (const c of journal.checkpoints) {
    sql.exec(
      "INSERT INTO journal_checkpoints (seq, version, state, checksum, timers) VALUES (?, ?, ?, ?, ?)",
      c.seq,
      c.version,
      c.state,
      c.checksum,
      c.timers ?? "[]",
    );
  }
}
