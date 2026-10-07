/**
 * StudioRegistry — Durable Object that tracks all known actor instances.
 *
 * Auto-discovered by the actor runtime via ctx.exports.
 * Stores actor type, ID, last activity, and connection counts.
 * Provides list/search/filter for the studio dashboard.
 */

import { DurableObject } from "cloudflare:workers";
import { DOQB } from "workers-qb";

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
];

interface ActorEntry {
  actorType: string;
  actorId: string;
  lastActiveAt: number;
  version: number | null;
  connectionCount: number;
}

interface ListOptions {
  type?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export class StudioRegistry extends DurableObject {
  migrated = false;

  /** Marker property for runtime detection via ctx.exports. */
  static readonly __actorKitStudioRegistry = true;

  ensureMigrated(): void {
    if (this.migrated) return;
    new DOQB(this.ctx.storage.sql).migrations({ migrations: REGISTRY_MIGRATIONS }).apply();
    this.migrated = true;
  }

  /** Called by actors (fire-and-forget) to register/update activity. */
  touch(actorType: string, actorId: string, version: number): void {
    this.ensureMigrated();
    this.ctx.storage.sql.exec(
      `INSERT INTO actors (actor_type, actor_id, last_active_at, version, connection_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(actor_type, actor_id) DO UPDATE SET
         last_active_at = excluded.last_active_at,
         version = excluded.version`,
      actorType,
      actorId,
      Date.now(),
      version,
    );
  }

  /** Called by actors to update connection count. */
  updateConnections(actorType: string, actorId: string, count: number): void {
    this.ensureMigrated();
    this.ctx.storage.sql.exec(
      `UPDATE actors SET connection_count = ?, last_active_at = ? WHERE actor_type = ? AND actor_id = ?`,
      count,
      Date.now(),
      actorType,
      actorId,
    );
  }

  /** Called by studio middleware to list actors. */
  async listActors(opts: ListOptions): Promise<ActorEntry[]> {
    this.ensureMigrated();
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    let query: string;
    const params: unknown[] = [];

    if (opts.type !== undefined && opts.search !== undefined) {
      query = `SELECT actor_type, actor_id, last_active_at, version, connection_count
               FROM actors WHERE actor_type = ? AND actor_id LIKE ?
               ORDER BY last_active_at DESC LIMIT ? OFFSET ?`;
      params.push(opts.type, `%${opts.search}%`, limit, offset);
    } else if (opts.type !== undefined) {
      query = `SELECT actor_type, actor_id, last_active_at, version, connection_count
               FROM actors WHERE actor_type = ?
               ORDER BY last_active_at DESC LIMIT ? OFFSET ?`;
      params.push(opts.type, limit, offset);
    } else if (opts.search !== undefined) {
      query = `SELECT actor_type, actor_id, last_active_at, version, connection_count
               FROM actors WHERE actor_id LIKE ?
               ORDER BY last_active_at DESC LIMIT ? OFFSET ?`;
      params.push(`%${opts.search}%`, limit, offset);
    } else {
      query = `SELECT actor_type, actor_id, last_active_at, version, connection_count
               FROM actors ORDER BY last_active_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
    }

    const rows = this.ctx.storage.sql.exec(query, ...params).toArray();

    return rows.map((row) => ({
      actorType: row["actor_type"] as string,
      actorId: row["actor_id"] as string,
      lastActiveAt: row["last_active_at"] as number,
      version: row["version"] as number | null,
      connectionCount: row["connection_count"] as number,
    }));
  }

  /** Exact lookup used by the studio middleware before it contacts an actor DO. */
  async hasActor(actorType: string, actorId: string): Promise<boolean> {
    this.ensureMigrated();
    const rows = this.ctx.storage.sql
      .exec("SELECT 1 FROM actors WHERE actor_type = ? AND actor_id = ? LIMIT 1", actorType, actorId)
      .toArray();
    return rows.length > 0;
  }

  /** Get distinct actor types. */
  async getActorTypes(): Promise<string[]> {
    this.ensureMigrated();
    const rows = this.ctx.storage.sql.exec("SELECT DISTINCT actor_type FROM actors ORDER BY actor_type").toArray();
    return rows.map((row) => row["actor_type"] as string);
  }
}
