/**
 * The executions outbox in SQLite (ADR-003, ADR-015 D1).
 *
 * Row lifecycle: `pending` → `running` → `done` | `retrying` (waits until next_attempt_at, then
 * runs again) | `failed`. `failed` is final: failed rows are the dead letters, kept until an
 * operator redrives them (back to `pending`, same effect id). Rows are keyed by effect id
 * (`seq:index`) and ordered by (seq, idx) as integers.
 *
 * Every function takes the structural `JournalSql` slice of SqlStorage, so this module runs
 * (and is tested) without the Workers runtime. Rows are parsed with Zod at this boundary.
 */

import { z } from "zod";
import type { JournalSql } from "./journal";
import type { AttemptSettlement } from "./retry";

export interface NewExecution {
  readonly id: string;
  readonly seq: number;
  readonly index: number;
  readonly service: string;
  readonly input: unknown;
  readonly createdAt: number;
}

export interface DueExecution {
  readonly id: string;
  readonly service: string;
  readonly input: unknown;
  readonly attempts: number;
}

export interface OutboxRow {
  id: string;
  service: string;
  /** JSON-encoded input, as stored. */
  payload: string;
  status: string;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}

export function insertExecutions(sql: JournalSql, entries: readonly NewExecution[]): void {
  for (const entry of entries) {
    sql.exec(
      "INSERT INTO executions (id, seq, idx, service, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)",
      entry.id,
      entry.seq,
      entry.index,
      entry.service,
      JSON.stringify(entry.input ?? null),
      entry.createdAt,
    );
  }
}

const DueRow = z.object({ id: z.string(), service: z.string(), payload: z.string(), attempts: z.number() });

/** Rows to run now: every `pending` row, and `retrying` rows whose time has come; oldest effect first. */
export function dueExecutions(sql: JournalSql, now: number): DueExecution[] {
  return sql
    .exec(
      "SELECT id, service, payload, attempts FROM executions WHERE status = 'pending' OR (status = 'retrying' AND next_attempt_at <= ?) ORDER BY seq, idx",
      now,
    )
    .toArray()
    .map((raw) => {
      const row = DueRow.parse(raw);
      const input: unknown = JSON.parse(row.payload);
      return { id: row.id, service: row.service, input, attempts: row.attempts };
    });
}

const AttemptsRow = z.object({ attempts: z.number() });

/** Mark a row `running` and count the try. Returns the try's number (1 = first). */
export function startAttempt(sql: JournalSql, id: string): number {
  const row = sql
    .exec(
      "UPDATE executions SET status = 'running', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? RETURNING attempts",
      id,
    )
    .toArray()[0];
  return AttemptsRow.parse(row).attempts;
}

/** Record how a try ended. `error` is the try's error message (null on success). */
export function finishAttempt(sql: JournalSql, id: string, settlement: AttemptSettlement, error: string | null): void {
  const nextAttemptAt = settlement.status === "retrying" ? settlement.nextAttemptAt : null;
  sql.exec(
    "UPDATE executions SET status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
    settlement.status,
    nextAttemptAt,
    error,
    id,
  );
}

/** Rows left `running` by a crash or eviction run again (delivery is at-least-once). */
export function requeueInterrupted(sql: JournalSql): void {
  sql.exec("UPDATE executions SET status = 'pending' WHERE status = 'running'");
}

const NextRow = z.object({ next: z.number().nullable() });

/** When the earliest `retrying` row is due, or null if none is waiting. */
export function nextRetryAt(sql: JournalSql): number | null {
  const row = sql.exec("SELECT MIN(next_attempt_at) AS next FROM executions WHERE status = 'retrying'").toArray()[0];
  return NextRow.parse(row).next;
}

/** Move a dead letter (`failed`) back to `pending` under the same effect id. False if it isn't one. */
export function redriveExecution(sql: JournalSql, id: string): boolean {
  const rows = sql
    .exec(
      "UPDATE executions SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND status = 'failed' RETURNING id",
      id,
    )
    .toArray();
  return rows.length > 0;
}

const OutboxDbRow = z.object({
  id: z.string(),
  service: z.string(),
  payload: z.string(),
  status: z.string(),
  attempts: z.number(),
  created_at: z.number(),
  next_attempt_at: z.number().nullable(),
  last_error: z.string().nullable(),
});

/** Every execution row, newest effect first. Payloads are raw: project them before Studio sees them. */
export function readOutboxRows(sql: JournalSql): OutboxRow[] {
  return sql
    .exec(
      "SELECT id, service, payload, status, attempts, created_at, next_attempt_at, last_error FROM executions ORDER BY seq DESC, idx DESC",
    )
    .toArray()
    .map((raw) => {
      const row = OutboxDbRow.parse(raw);
      return {
        id: row.id,
        service: row.service,
        payload: row.payload,
        status: row.status,
        attempts: row.attempts,
        createdAt: row.created_at,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
      };
    });
}

/**
 * Restore (ADR-015 D3): executions and forwards declared after `toSeq` belong to undone
 * transitions. Those still waiting (or in flight) become dead letters carrying `reason`, so an
 * operator can see and redrive them; nothing is run for an undone transition behind their back.
 */
export function cancelUndoneEffects(sql: JournalSql, toSeq: number, reason: string): void {
  sql.exec(
    "UPDATE executions SET status = 'failed', next_attempt_at = NULL, last_error = ? WHERE seq > ? AND status IN ('pending', 'retrying', 'running')",
    reason,
    toSeq,
  );
  sql.exec("UPDATE forwards SET status = 'failed' WHERE seq > ? AND status = 'pending'", toSeq);
}

/** Whether a row is still `running`: false once a restore cancelled the try in flight. */
export function isRunning(sql: JournalSql, id: string): boolean {
  return sql.exec("SELECT 1 AS one FROM executions WHERE id = ? AND status = 'running'", id).toArray().length > 0;
}

export interface OutboxFailedEvent {
  readonly event: "actor_kit.outbox.failed";
  readonly actorType: string;
  readonly actorId: string;
  readonly kind: "execution";
  readonly service: string;
  readonly effectId: string;
  readonly attempts: number;
  readonly error: string;
}

/**
 * The wide event logged when an execution becomes a dead letter. Stable fields come first so log
 * tooling (sre-agent) can fingerprint on event + actorType + service; the input is never logged.
 */
export function outboxFailedEvent(fields: {
  actorType: string;
  actorId: string;
  effectId: string;
  service: string;
  attempts: number;
  error: string;
}): OutboxFailedEvent {
  return {
    event: "actor_kit.outbox.failed",
    actorType: fields.actorType,
    actorId: fields.actorId,
    kind: "execution",
    service: fields.service,
    effectId: fields.effectId,
    attempts: fields.attempts,
    error: fields.error,
  };
}
