/**
 * The projection's bookkeeping in D1, next to the read model (ADR-019 E):
 *
 * - `<table>_cursor (actor_type, actor_id, position, seq)`: the positions applied, newest kept (and
 *   the last few before it). The primary key makes applying one position twice fail its batch, so
 *   two consumers racing on an event apply it once.
 * - `<table>_buffer (actor_type, actor_id, position, event)`: events that arrived before an earlier
 *   one, held until the gap fills.
 */

import { z } from "zod";
import { type ActorKey, type ProjectionEvent, ProjectionEventSchema } from "./event";

/** Structural slice of a D1 prepared statement. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  run(): Promise<unknown>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}

/** Structural slice of a D1 database (`D1Database` satisfies it). */
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<unknown>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PositionRow = z.object({ position: z.number().nullable() });
const EventRow = z.object({ event: z.string() });
const BufferedRow = z.object({
  actor_type: z.string(),
  actor_id: z.string(),
  applied: z.number().nullable(),
  next: z.number(),
  count: z.number(),
});

export interface BufferedActor extends ActorKey {
  /** The last position applied (0 before any). */
  readonly applied: number;
  /** The lowest position waiting. Greater than applied + 1: an earlier event has not arrived. */
  readonly next: number;
  readonly count: number;
}

export interface Store {
  ensure(db: SqlDatabase): Promise<void>;
  cursor(db: SqlDatabase, actor: ActorKey): Promise<number>;
  buffer(db: SqlDatabase, events: readonly ProjectionEvent[]): Promise<void>;
  /** Buffered events after `applied`, lowest position first (rows at or before it are dropped). */
  pending(db: SqlDatabase, actor: ActorKey, applied: number): Promise<ProjectionEvent[]>;
  /** Statements that record `event` as applied: run them in the batch that applies it. */
  applied(db: SqlDatabase, event: ProjectionEvent): SqlStatement[];
  /** Statements that forget every cursor and buffered event (a rebuild). */
  reset(db: SqlDatabase): SqlStatement[];
  buffered(db: SqlDatabase): Promise<BufferedActor[]>;
}

export function createStore(table: string, keepCursorRows: number): Store {
  if (!IDENTIFIER.test(table)) throw new Error(`projection: table "${table}" must be a SQL identifier`);
  const cursor = `${table}_cursor`;
  const buffer = `${table}_buffer`;
  const ACTOR = "actor_type = ? AND actor_id = ?";

  return {
    async ensure(db) {
      await db.batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS ${cursor} (actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, position INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (actor_type, actor_id, position))`,
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS ${buffer} (actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, position INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (actor_type, actor_id, position))`,
        ),
      ]);
    },

    async cursor(db, actor) {
      const { results } = await db
        .prepare(`SELECT MAX(position) AS position FROM ${cursor} WHERE ${ACTOR}`)
        .bind(actor.actorType, actor.actorId)
        .all();
      return PositionRow.parse(results[0]).position ?? 0;
    },

    async buffer(db, events) {
      await db.batch(
        events.map((event) =>
          db
            .prepare(`INSERT OR IGNORE INTO ${buffer} (actor_type, actor_id, position, event) VALUES (?, ?, ?, ?)`)
            .bind(event.actorType, event.actorId, event.position, JSON.stringify(event)),
        ),
      );
    },

    async pending(db, actor, applied) {
      await db
        .prepare(`DELETE FROM ${buffer} WHERE ${ACTOR} AND position <= ?`)
        .bind(actor.actorType, actor.actorId, applied)
        .run();
      const { results } = await db
        .prepare(`SELECT event FROM ${buffer} WHERE ${ACTOR} ORDER BY position`)
        .bind(actor.actorType, actor.actorId)
        .all();
      return results.map((row) => ProjectionEventSchema.parse(JSON.parse(EventRow.parse(row).event)));
    },

    applied(db, event) {
      const { actorType, actorId, position } = event;
      return [
        db
          .prepare(`INSERT INTO ${cursor} (actor_type, actor_id, position, seq) VALUES (?, ?, ?, ?)`)
          .bind(actorType, actorId, position, event.seq),
        db
          .prepare(`DELETE FROM ${cursor} WHERE ${ACTOR} AND position < ?`)
          .bind(actorType, actorId, position - keepCursorRows),
        db.prepare(`DELETE FROM ${buffer} WHERE ${ACTOR} AND position = ?`).bind(actorType, actorId, position),
      ];
    },

    reset(db) {
      return [db.prepare(`DELETE FROM ${cursor}`), db.prepare(`DELETE FROM ${buffer}`)];
    },

    async buffered(db) {
      const { results } = await db
        .prepare(
          `SELECT actor_type, actor_id, MIN(position) AS next, COUNT(*) AS count, applied FROM (SELECT b.actor_type, b.actor_id, b.position, (SELECT MAX(c.position) FROM ${cursor} c WHERE c.actor_type = b.actor_type AND c.actor_id = b.actor_id) AS applied FROM ${buffer} b) WHERE position > COALESCE(applied, 0) GROUP BY actor_type, actor_id ORDER BY actor_type, actor_id`,
        )
        .all();
      return results.map((row) => {
        const parsed = BufferedRow.parse(row);
        return {
          actorType: parsed.actor_type,
          actorId: parsed.actor_id,
          applied: parsed.applied ?? 0,
          next: parsed.next,
          count: parsed.count,
        };
      });
    },
  };
}
