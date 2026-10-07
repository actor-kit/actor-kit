/**
 * Pure parsing and SQL building for StudioRegistry. No Cloudflare runtime imports,
 * so it is unit-testable; registry.ts is the thin DO shell around it.
 */

import { z } from "zod";

export const DEFAULT_LIST_LIMIT = 50;

const ActorKey = z.object({
  actorType: z.string().min(1),
  actorId: z.string().min(1),
});

export const TouchArgs = ActorKey.extend({
  version: z.number().int(),
  previousActorId: z.string().min(1).optional(),
});

export const ConnectionArgs = ActorKey.extend({
  count: z.number().int().nonnegative(),
});

export const ListOptionsSchema = z.object({
  type: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type ListOptions = z.input<typeof ListOptionsSchema>;

export const ActorRow = z
  .object({
    actor_type: z.string(),
    actor_id: z.string(),
    last_active_at: z.number(),
    version: z.number().nullable(),
    connection_count: z.number(),
  })
  .transform((row) => ({
    actorType: row.actor_type,
    actorId: row.actor_id,
    lastActiveAt: row.last_active_at,
    version: row.version,
    connectionCount: row.connection_count,
  }));

export type ActorEntry = z.output<typeof ActorRow>;

export const ActorTypeRow = z.object({ actor_type: z.string() });

/** Escape LIKE metacharacters so search text matches literally (pair with ESCAPE '\'). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build the listing query. Throws a ZodError for invalid options (negative, fractional or
 * NaN limit/offset) rather than letting SQLite treat a negative LIMIT as "no limit".
 */
export function buildListQuery(opts: unknown): { sql: string; params: Array<string | number> } {
  const parsed = ListOptionsSchema.parse(opts);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (parsed.type !== undefined) {
    where.push("actor_type = ?");
    params.push(parsed.type);
  }
  if (parsed.search !== undefined) {
    where.push("actor_id LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(parsed.search)}%`);
  }
  params.push(parsed.limit ?? DEFAULT_LIST_LIMIT, parsed.offset ?? 0);

  const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  // Tiebreakers keep pagination stable when several actors share a timestamp.
  const sql =
    "SELECT actor_type, actor_id, last_active_at, version, connection_count FROM actors" +
    whereClause +
    " ORDER BY last_active_at DESC, actor_type ASC, actor_id ASC LIMIT ? OFFSET ?";
  return { sql, params };
}
