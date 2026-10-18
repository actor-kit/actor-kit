/**
 * Delivered client message ids (ADR-021 spike): which `__id`s this actor has applied (or refused)
 * for each caller, so a client resending after a lost ack is not applied twice. Kept in SQLite so
 * it survives hibernation and restart; the last `DELIVERED_KEEP` ids are kept.
 */
import type { JournalSql } from "./journal";

export const DELIVERED_KEEP = 1000;

export function ensureDeliveredTable(sql: JournalSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS delivered_messages (caller TEXT NOT NULL, id TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY (caller, id))",
  );
}

export function wasDelivered(sql: JournalSql, caller: string, id: string): boolean {
  return sql.exec("SELECT 1 FROM delivered_messages WHERE caller = ? AND id = ?", caller, id).toArray().length > 0;
}

export function recordDelivered(sql: JournalSql, caller: string, id: string, now: number, keep = DELIVERED_KEEP): void {
  sql.exec("INSERT OR IGNORE INTO delivered_messages (caller, id, delivered_at) VALUES (?, ?, ?)", caller, id, now);
  sql.exec(
    "DELETE FROM delivered_messages WHERE rowid NOT IN (SELECT rowid FROM delivered_messages ORDER BY delivered_at DESC, rowid DESC LIMIT ?)",
    keep,
  );
}
