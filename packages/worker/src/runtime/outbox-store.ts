/**
 * The outbox in SQLite (ADR-003, ADR-015 D1): executions and forwards.
 *
 * Row lifecycle: `pending` → `running` → `done` | `retrying` (waits until next_attempt_at, then
 * runs again) | `failed`. `failed` is final: failed rows are the dead letters, kept until an
 * operator redrives them (back to `pending`, same effect id). Rows are keyed by effect id
 * (`seq:index`) and ordered by (seq, idx) as integers. Forwards follow the same lifecycle in their own
 * table; the attempt functions take the table (executions by default).
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

/** The outbox tables. Constants only: the name is interpolated into SQL. */
export type EffectTable = "executions" | "forwards";

export interface NewForward {
  readonly id: string;
  readonly seq: number;
  readonly index: number;
  readonly linkName: string;
  readonly targetId: string;
  readonly message: unknown;
  readonly createdAt: number;
}

export interface DueForward {
  readonly id: string;
  readonly linkName: string;
  readonly targetId: string;
  /** JSON text, as stored; parsed when delivered. */
  readonly message: string;
  readonly caller: string;
  readonly callerType: string;
}

export interface OutboxRow {
  id: string;
  /** The service, or for a forward the link it goes through. */
  service: string;
  /** JSON-encoded input, as stored. */
  payload: string;
  status: string;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  /** Forwards only: rows without `kind` are executions. */
  kind?: "forward";
  /** Forwards only: the target actor's id. */
  target?: string;
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

export function insertForwards(
  sql: JournalSql,
  entries: readonly NewForward[],
  caller: string,
  callerType: "user" | "service",
): void {
  for (const entry of entries) {
    sql.exec(
      "INSERT INTO forwards (id, seq, idx, link_name, target_id, message, caller, caller_type, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
      entry.id,
      entry.seq,
      entry.index,
      entry.linkName,
      entry.targetId,
      JSON.stringify(entry.message),
      caller,
      callerType,
      entry.createdAt,
    );
  }
}

const DueForwardRow = z.object({
  id: z.string(),
  link_name: z.string(),
  target_id: z.string(),
  message: z.string(),
  caller: z.string(),
  caller_type: z.string(),
});

/** Forwards to send now: `pending` ones and `retrying` ones whose time has come; oldest effect first. */
export function dueForwards(sql: JournalSql, now: number): DueForward[] {
  return sql
    .exec(
      "SELECT id, link_name, target_id, message, caller, caller_type FROM forwards WHERE status = 'pending' OR (status = 'retrying' AND next_attempt_at <= ?) ORDER BY seq, idx",
      now,
    )
    .toArray()
    .map((raw) => {
      const row = DueForwardRow.parse(raw);
      return {
        id: row.id,
        linkName: row.link_name,
        targetId: row.target_id,
        message: row.message,
        caller: row.caller,
        callerType: row.caller_type,
      };
    });
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
export function startAttempt(sql: JournalSql, id: string, table: EffectTable = "executions"): number {
  const row = sql
    .exec(
      `UPDATE ${table} SET status = 'running', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? RETURNING attempts`,
      id,
    )
    .toArray()[0];
  return AttemptsRow.parse(row).attempts;
}

/** Record how a try ended. `error` is the try's error message (null on success). */
export function finishAttempt(
  sql: JournalSql,
  id: string,
  settlement: AttemptSettlement,
  error: string | null,
  table: EffectTable = "executions",
): void {
  const nextAttemptAt = settlement.status === "retrying" ? settlement.nextAttemptAt : null;
  sql.exec(
    `UPDATE ${table} SET status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
    settlement.status,
    nextAttemptAt,
    error,
    id,
  );
}

/** Rows left `running` by a crash or eviction run again (delivery is at-least-once). */
export function requeueInterrupted(sql: JournalSql): void {
  sql.exec("UPDATE executions SET status = 'pending' WHERE status = 'running'");
  sql.exec("UPDATE forwards SET status = 'pending' WHERE status = 'running'");
}

const NextRow = z.object({ next: z.number().nullable() });

/** When the earliest `retrying` row (execution or forward) is due, or null if none is waiting. */
export function nextRetryAt(sql: JournalSql): number | null {
  const row = sql
    .exec(
      "SELECT MIN(next_attempt_at) AS next FROM (SELECT next_attempt_at FROM executions WHERE status = 'retrying' UNION ALL SELECT next_attempt_at FROM forwards WHERE status = 'retrying')",
    )
    .toArray()[0];
  return NextRow.parse(row).next;
}

/** Move a dead letter (`failed`) back to `pending` under the same effect id. False if it isn't one. */
export function redriveExecution(sql: JournalSql, id: string, table: EffectTable = "executions"): boolean {
  const rows = sql
    .exec(
      `UPDATE ${table} SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND status = 'failed' RETURNING id`,
      id,
    )
    .toArray();
  return rows.length > 0;
}

const OutboxDbRow = z.object({
  seq: z.number(),
  idx: z.number(),
  id: z.string(),
  service: z.string(),
  payload: z.string(),
  status: z.string(),
  attempts: z.number(),
  created_at: z.number(),
  next_attempt_at: z.number().nullable(),
  last_error: z.string().nullable(),
  target: z.string().nullable(),
});

/**
 * Every execution and forward row, newest effect first. Payloads (a forward's message) are raw:
 * project them before Studio sees them.
 */
export function readOutboxRows(sql: JournalSql): OutboxRow[] {
  return sql
    .exec(
      `SELECT seq, idx, id, service, payload, status, attempts, created_at, next_attempt_at, last_error, NULL AS target FROM executions
       UNION ALL
       SELECT seq, idx, id, link_name, message, status, attempts, created_at, next_attempt_at, last_error, target_id FROM forwards
       ORDER BY seq DESC, idx DESC`,
    )
    .toArray()
    .map((raw) => toOutboxRow(OutboxDbRow.parse(raw)));
}

function toOutboxRow(row: z.infer<typeof OutboxDbRow>): OutboxRow {
  const base: OutboxRow = {
    id: row.id,
    service: row.service,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  };
  return row.target === null ? base : { ...base, kind: "forward", target: row.target };
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
  sql.exec(
    "UPDATE forwards SET status = 'failed', next_attempt_at = NULL, last_error = ? WHERE seq > ? AND status IN ('pending', 'retrying', 'running')",
    reason,
    toSeq,
  );
}

/** Whether a row is still `running`: false once a restore cancelled the try in flight. */
export function isRunning(sql: JournalSql, id: string, table: EffectTable = "executions"): boolean {
  return sql.exec(`SELECT 1 AS one FROM ${table} WHERE id = ? AND status = 'running'`, id).toArray().length > 0;
}

export interface OutboxFailedEvent {
  readonly event: "actor_kit.outbox.failed";
  readonly actorType: string;
  readonly actorId: string;
  readonly kind: "execution" | "forward";
  /** The service, or for a forward the link it went through. */
  readonly service: string;
  readonly effectId: string;
  readonly attempts: number;
  readonly error: string;
}

/**
 * The wide event logged when an execution or a forward becomes a dead letter. Stable fields come first so log
 * tooling (sre-agent) can fingerprint on event + actorType + service; the input is never logged.
 */
export function outboxFailedEvent(fields: {
  kind?: "execution" | "forward";
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
    kind: fields.kind ?? "execution",
    service: fields.service,
    effectId: fields.effectId,
    attempts: fields.attempts,
    error: fields.error,
  };
}
