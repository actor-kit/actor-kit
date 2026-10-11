/**
 * ADR-019 E: a read model of Lot's published `Placed` events (publish-actors.ts) in D1: one row per
 * event in position order, and a running total per lot. The test Worker consumes `lot-events` with it.
 */
import { projection } from "@actor-kit/projection";
import { z } from "zod";

export interface ProjectionEnv {
  PROJECTION_DB: D1Database;
}

const Placed = z.object({ n: z.number() });

export async function ensureLotReadModel(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS lot_log (actor_id TEXT NOT NULL, position INTEGER NOT NULL, seq INTEGER NOT NULL, n INTEGER NOT NULL)",
    ),
    db.prepare("CREATE TABLE IF NOT EXISTS lot_totals (actor_id TEXT PRIMARY KEY, total INTEGER NOT NULL)"),
  ]);
}

export const lotProjection = projection({
  queue: "lot-events",
  db: (env: ProjectionEnv) => env.PROJECTION_DB,
  apply: (event, { db }) => {
    if (event.name !== "Placed") return [];
    const { n } = Placed.parse(event.payload);
    return [
      db
        .prepare("INSERT INTO lot_log (actor_id, position, seq, n) VALUES (?, ?, ?, ?)")
        .bind(event.actorId, event.position, event.seq, n),
      db
        .prepare(
          "INSERT INTO lot_totals (actor_id, total) VALUES (?, ?) ON CONFLICT(actor_id) DO UPDATE SET total = total + excluded.total",
        )
        .bind(event.actorId, n),
    ];
  },
  reset: ({ db }) => [db.prepare("DELETE FROM lot_log"), db.prepare("DELETE FROM lot_totals")],
});
