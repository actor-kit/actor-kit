/**
 * The timers table (ADR-015 D2). One row per pending timer, keyed by its effect id, with a
 * unique key: scheduling an existing key replaces it. A fired or cancelled timer is deleted, so
 * the table is the truth for pending timers (also with `journal: false`). Rows are parsed with
 * Zod at this boundary.
 */

import { z } from "zod";
import type { JournalSql } from "./journal";
import type { TimerOp } from "./outbox";

export interface TimerRow {
  id: string;
  name: string;
  key: string;
  /** JSON-encoded payload, as stored. Project it before Studio sees it. */
  payload: string;
  fireAt: number;
  createdAt: number;
}

export interface DueTimer {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly payload: unknown;
  readonly fireAt: number;
}

/** Apply a transition's schedules and cancels in declaration order (inside its transaction). */
export function applyTimerOps(sql: JournalSql, ops: readonly TimerOp[], now: number): void {
  for (const op of ops) {
    if (op.op === "cancel") {
      sql.exec("DELETE FROM timers WHERE key = ?", op.key);
    } else {
      sql.exec(
        "INSERT OR REPLACE INTO timers (id, seq, idx, name, key, payload, fire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        op.id,
        op.seq,
        op.index,
        op.name,
        op.key,
        JSON.stringify(op.payload ?? null),
        op.fireAt,
        now,
      );
    }
  }
}

const DueRow = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  payload: z.string(),
  fire_at: z.number(),
});

function toDue(raw: unknown): DueTimer {
  const row = DueRow.parse(raw);
  const payload: unknown = JSON.parse(row.payload);
  return { id: row.id, name: row.name, key: row.key, payload, fireAt: row.fire_at };
}

/**
 * The next timer to fire: due by `now`, scheduled at or before transition `maxSeq` (timers a firing
 * schedules wait for the next alarm), earliest (fire_at, seq, idx) first. Null when none is due.
 */
export function dueTimer(sql: JournalSql, now: number, maxSeq: number): DueTimer | null {
  const row = sql
    .exec(
      "SELECT id, name, key, payload, fire_at FROM timers WHERE fire_at <= ? AND seq <= ? ORDER BY fire_at, seq, idx LIMIT 1",
      now,
      maxSeq,
    )
    .toArray()[0];
  return row === undefined ? null : toDue(row);
}

export function timerByKey(sql: JournalSql, key: string): DueTimer | null {
  const row = sql.exec("SELECT id, name, key, payload, fire_at FROM timers WHERE key = ?", key).toArray()[0];
  return row === undefined ? null : toDue(row);
}

export function deleteTimer(sql: JournalSql, id: string): void {
  sql.exec("DELETE FROM timers WHERE id = ?", id);
}

const NextRow = z.object({ next: z.number().nullable() });

/** The earliest pending deadline, or null when no timer is pending. */
export function nextTimerAt(sql: JournalSql): number | null {
  return NextRow.parse(sql.exec("SELECT MIN(fire_at) AS next FROM timers").toArray()[0]).next;
}

const TimerDbRow = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  payload: z.string(),
  fire_at: z.number(),
  created_at: z.number(),
});

/** Every pending timer, soonest first. */
export function readTimers(sql: JournalSql): TimerRow[] {
  return sql
    .exec("SELECT id, name, key, payload, fire_at, created_at FROM timers ORDER BY fire_at, seq, idx")
    .toArray()
    .map((raw) => {
      const row = TimerDbRow.parse(raw);
      return {
        id: row.id,
        name: row.name,
        key: row.key,
        payload: row.payload,
        fireAt: row.fire_at,
        createdAt: row.created_at,
      };
    });
}

/** The DO has one alarm: the earlier of the next timer and the next outbox retry (null: none). */
export function earliestDeadline(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export interface TimerFailedEvent {
  readonly event: "actor_kit.timer.failed";
  readonly actorType: string;
  readonly actorId: string;
  readonly timer: string;
  readonly key: string;
  readonly timerId: string;
  readonly fireAt: number;
  readonly error: string;
}

/** The wide event logged when a timer is dropped because it could not fire. No payload is logged. */
export function timerFailedEvent(actorType: string, actorId: string, due: DueTimer, error: unknown): TimerFailedEvent {
  return {
    event: "actor_kit.timer.failed",
    actorType,
    actorId,
    timer: due.name,
    key: due.key,
    timerId: due.id,
    fireAt: due.fireAt,
    error: error instanceof Error ? error.message : String(error),
  };
}
