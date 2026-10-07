/**
 * StudioRegistry — Durable Object that tracks all known actor instances.
 *
 * Auto-discovered by the actor runtime via ctx.exports.
 * Stores actor type, ID, last activity, and connection counts.
 * Provides list/search/filter for the studio dashboard.
 *
 * Every RPC argument is parsed with Zod: these methods are called across a DO boundary.
 * Fire-and-forget writes (`touch`, `updateConnections`) drop invalid input instead of
 * throwing, so a bad call never surfaces as an unhandled rejection inside the calling actor.
 */

import { DurableObject } from "cloudflare:workers";
import { DOQB } from "workers-qb";
import {
  type ActorEntry,
  ActorRow,
  ActorTypeRow,
  buildListQuery,
  ConnectionArgs,
  type ListOptions,
  LookupArgs,
  TouchArgs,
} from "./registry-query";

export type { ActorEntry, ListOptions };

const REGISTRY_MIGRATIONS = [
  {
    name: "0001_actors",
    sql: `
      CREATE TABLE IF NOT EXISTS actors (
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        last_active_at INTEGER NOT NULL,
        version INTEGER,
        connection_count INTEGER DEFAULT 0,
        PRIMARY KEY (actor_type, actor_id)
      );
      CREATE INDEX IF NOT EXISTS idx_actors_recency ON actors(last_active_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(actor_type, last_active_at DESC);
    `,
  },
  {
    // The DO hex id survives re-keying (hex id -> spawn name), so Studio can still find the actor by it.
    name: "0002_actors_do_id",
    sql: `
      ALTER TABLE actors ADD COLUMN do_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_actors_do_id ON actors(actor_type, do_id);
    `,
  },
];

export class StudioRegistry extends DurableObject {
  migrated = false;

  /** Marker property for runtime detection via ctx.exports. */
  static readonly __actorKitStudioRegistry = true;

  ensureMigrated(): void {
    if (this.migrated) return;
    new DOQB(this.ctx.storage.sql).migrations({ migrations: REGISTRY_MIGRATIONS }).apply();
    this.migrated = true;
  }

  /**
   * Called by actors (fire-and-forget) to register/update activity.
   * `previousActorId` re-keys an actor that was registered under another ID (e.g. its hex
   * DO ID before spawn() named it): the old row is removed and its connection count kept.
   */
  touch(actorType: string, actorId: string, version: number, previousActorId?: string, doId?: string): void {
    const parsed = TouchArgs.safeParse({ actorType, actorId, version, previousActorId, doId });
    if (!parsed.success) return;
    const args = parsed.data;
    this.ensureMigrated();
    const sql = this.ctx.storage.sql;

    this.ctx.storage.transactionSync(() => {
      let carriedConnections = 0;
      let carriedDoId: string | null = null;
      if (args.previousActorId !== undefined && args.previousActorId !== args.actorId) {
        const previous = sql
          .exec(
            "DELETE FROM actors WHERE actor_type = ? AND actor_id = ? RETURNING connection_count, do_id",
            args.actorType,
            args.previousActorId,
          )
          .toArray();
        const count = previous[0]?.["connection_count"];
        if (typeof count === "number") carriedConnections = count;
        const previousDoId = previous[0]?.["do_id"];
        if (typeof previousDoId === "string") carriedDoId = previousDoId;
      }

      sql.exec(
        `INSERT INTO actors (actor_type, actor_id, last_active_at, version, connection_count, do_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(actor_type, actor_id) DO UPDATE SET
           last_active_at = excluded.last_active_at,
           version = excluded.version,
           do_id = COALESCE(excluded.do_id, actors.do_id)`,
        args.actorType,
        args.actorId,
        Date.now(),
        args.version,
        carriedConnections,
        args.doId ?? carriedDoId,
      );
    });
  }

  /**
   * Called by actors to update connection count. A connection is real activity, so an
   * actor not yet registered (e.g. persisted before Studio was enabled) is registered here.
   */
  updateConnections(actorType: string, actorId: string, count: number, doId?: string): void {
    const parsed = ConnectionArgs.safeParse({ actorType, actorId, count, doId });
    if (!parsed.success) return;
    const args = parsed.data;
    this.ensureMigrated();
    this.ctx.storage.sql.exec(
      `INSERT INTO actors (actor_type, actor_id, last_active_at, version, connection_count, do_id)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(actor_type, actor_id) DO UPDATE SET
         connection_count = excluded.connection_count,
         last_active_at = excluded.last_active_at,
         do_id = COALESCE(excluded.do_id, actors.do_id)`,
      args.actorType,
      args.actorId,
      Date.now(),
      args.count,
      args.doId ?? null,
    );
  }

  /** Called by studio middleware to list actors, newest first. */
  async listActors(opts: ListOptions): Promise<ActorEntry[]> {
    const query = buildListQuery(opts);
    this.ensureMigrated();
    const rows = this.ctx.storage.sql.exec(query.sql, ...query.params).toArray();
    return rows.map((row) => ActorRow.parse(row));
  }

  /**
   * Exact lookup used by the studio middleware before it contacts an actor DO.
   * Matches the registered actor id or the DO hex id (which survives re-keying to a name).
   */
  async hasActor(actorType: string, actorId: string): Promise<boolean> {
    const parsed = LookupArgs.safeParse({ actorType, actorId });
    if (!parsed.success) return false;
    this.ensureMigrated();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM actors WHERE actor_type = ? AND (actor_id = ? OR do_id = ?) LIMIT 1",
        parsed.data.actorType,
        parsed.data.actorId,
        parsed.data.actorId,
      )
      .toArray();
    return rows.length > 0;
  }

  /** Get distinct actor types. */
  async getActorTypes(): Promise<string[]> {
    this.ensureMigrated();
    const rows = this.ctx.storage.sql.exec("SELECT DISTINCT actor_type FROM actors ORDER BY actor_type").toArray();
    return rows.map((row) => ActorTypeRow.parse(row).actor_type);
  }
}
