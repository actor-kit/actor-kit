/**
 * Journal archive to R2 (ADR-019 D). With `journal: { keep, archive: "R2_BINDING" }`, pruning first writes
 * the rows it would delete to the bucket as one NDJSON segment, then deletes them locally (in a
 * transaction) and records the segment in `journal_archive`. Readers (replay, restore, the journal query)
 * fetch the segments a range needs and merge them with the local journal.
 *
 * A segment covers the events from the oldest local one to the new base checkpoint (`<fromSeq>-<toSeq>`),
 * with the base checkpoint it starts from (seq fromSeq - 1, when there is one) and every checkpoint inside
 * it, so it can be replayed on its own. Lines: `{ "kind": "checkpoint" | "event", "row": <the SQLite row> }`,
 * checkpoints first. Rewriting a segment after a crash between the put and the delete writes the same key
 * with the same rows, so archiving is idempotent.
 */

import { ActorKitError } from "@actor-kit/core";
import { z } from "zod";
import {
  JOURNAL_EVENT_COLUMNS,
  type Journal,
  type JournalCheckpoint,
  type JournalSql,
  journalHighWater,
  parseCheckpointRow,
  parseJournalEventRow,
  readJournal,
} from "./journal";
import {
  type JournalPage,
  type JournalQuery,
  type JournalReadContext,
  journalEntry,
  matchesJournalQuery,
  readJournalPage,
} from "./journal-query";

/** The part of an R2 bucket the archive uses (structural, so tests use an in-memory one). */
export interface ArchiveBucket {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** Which actor a segment belongs to: its key is `actorType/actorId/<fromSeq>-<toSeq>.ndjson`. */
export interface ArchiveIds {
  readonly actorType: string;
  readonly actorId: string;
}

export interface ArchiveRange {
  readonly from: number;
  readonly to: number;
}

export interface ArchivedSegment extends ArchiveRange {
  readonly key: string;
  readonly bytes: number;
  readonly archivedAt: number;
}

const MaxRow = z.object({ seq: z.number().nullable() });

function maxSeq(sql: JournalSql, query: string, ...bindings: number[]): number | null {
  return MaxRow.parse(sql.exec(query, ...bindings).toArray()[0]).seq;
}

/**
 * What pruning to `upTo` removes: the local events from the oldest to the newest checkpoint at or before
 * `upTo` (that checkpoint stays as the new base). Null when there is none, or nothing before it.
 */
export function prunableRange(sql: JournalSql, upTo: number): ArchiveRange | null {
  const base = maxSeq(sql, "SELECT MAX(seq) AS seq FROM journal_checkpoints WHERE seq <= ?", upTo);
  if (base === null) return null;
  const oldest = maxSeq(sql, "SELECT MIN(seq) AS seq FROM events WHERE seq <= ?", base);
  return oldest === null ? null : { from: oldest, to: base };
}

export function segmentKey(ids: ArchiveIds, range: ArchiveRange): string {
  return `${ids.actorType}/${ids.actorId}/${range.from}-${range.to}.ndjson`;
}

/** The NDJSON segment for a range: its checkpoints (base included), then its events, oldest first. */
export function buildSegment(sql: JournalSql, range: ArchiveRange): string {
  const checkpoints = sql
    .exec("SELECT * FROM journal_checkpoints WHERE seq >= ? AND seq <= ? ORDER BY seq", range.from - 1, range.to)
    .toArray();
  const events = sql
    .exec(`SELECT ${JOURNAL_EVENT_COLUMNS} FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq`, range.from, range.to)
    .toArray();
  return [
    ...checkpoints.map((row) => JSON.stringify({ kind: "checkpoint", row })),
    ...events.map((row) => JSON.stringify({ kind: "event", row })),
  ].join("\n");
}

/** Parse a segment at the storage boundary. */
export function parseSegment(text: string): Journal {
  const SegmentLine = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("checkpoint"), row: z.unknown() }),
    z.object({ kind: z.literal("event"), row: z.unknown() }),
  ]);
  const journal: Journal = { events: [], checkpoints: [] };
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;
    try {
      const parsed = SegmentLine.parse(JSON.parse(line));
      if (parsed.kind === "event") journal.events.push(parseJournalEventRow(parsed.row));
      else journal.checkpoints.push(parseCheckpointRow(parsed.row));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new ActorKitError(
        "invalid_archive_segment",
        `Archived journal segment line ${index + 1} is invalid: ${why}`,
      );
    }
  }
  return journal;
}

/** Delete an archived range locally (keeping its last checkpoint as the new base) and record the segment. */
function dropArchived(sql: JournalSql, segment: ArchivedSegment): void {
  sql.exec("DELETE FROM events WHERE seq <= ?", segment.to);
  sql.exec("DELETE FROM journal_checkpoints WHERE seq < ?", segment.to);
  sql.exec(
    "INSERT OR REPLACE INTO journal_archive (from_seq, to_seq, key, bytes, archived_at) VALUES (?, ?, ?, ?, ?)",
    segment.from,
    segment.to,
    segment.key,
    segment.bytes,
    segment.archivedAt,
  );
}

/**
 * Archive what pruning to `upTo` removes: put the segment, then (in `atomically`, the Durable Object's
 * transaction) delete it locally and record it. Null when there is nothing to archive. A failed put
 * deletes nothing.
 */
export async function archiveJournal(
  sql: JournalSql,
  bucket: ArchiveBucket,
  ids: ArchiveIds,
  upTo: number,
  now: number,
  atomically: (write: () => void) => void = (write) => write(),
): Promise<ArchivedSegment | null> {
  const range = prunableRange(sql, upTo);
  if (range === null) return null;
  const body = buildSegment(sql, range);
  const key = segmentKey(ids, range);
  await bucket.put(key, body);
  const segment = { ...range, key, bytes: new TextEncoder().encode(body).byteLength, archivedAt: now };
  atomically(() => dropArchived(sql, segment));
  return segment;
}

const SegmentRow = z.object({
  from_seq: z.number(),
  to_seq: z.number(),
  key: z.string(),
  bytes: z.number(),
  archived_at: z.number(),
});

/** The archived segments, oldest first. */
export function archivedSegments(sql: JournalSql): ArchivedSegment[] {
  return sql
    .exec("SELECT from_seq, to_seq, key, bytes, archived_at FROM journal_archive ORDER BY from_seq")
    .toArray()
    .map((raw) => {
      const row = SegmentRow.parse(raw);
      return { from: row.from_seq, to: row.to_seq, key: row.key, bytes: row.bytes, archivedAt: row.archived_at };
    });
}

const LocalRow = z.union([
  z.object({ first: z.number(), last: z.number(), count: z.number() }),
  z.object({ first: z.null(), last: z.null(), count: z.number() }),
]);

/** Where the journal lives (Studio): the local range, each archived segment, and the archived bytes. */
export function journalStats(sql: JournalSql): {
  local: { from: number; to: number; events: number } | null;
  archived: Array<{ from: number; to: number; bytes: number }>;
  archivedBytes: number;
} {
  const local = LocalRow.parse(
    sql.exec("SELECT MIN(seq) AS first, MAX(seq) AS last, COUNT(*) AS count FROM events").toArray()[0],
  );
  const archived = archivedSegments(sql).map(({ from, to, bytes }) => ({ from, to, bytes }));
  return {
    local: local.first === null ? null : { from: local.first, to: local.last, events: local.count },
    archived,
    archivedBytes: archived.reduce((sum, segment) => sum + segment.bytes, 0),
  };
}

/** Read one archived segment from the bucket. */
async function fetchSegment(bucket: ArchiveBucket, segment: ArchivedSegment): Promise<Journal> {
  const object = await bucket.get(segment.key);
  if (object === null) {
    throw new ActorKitError(
      "archive_missing",
      `Archived journal segment "${segment.key}" (seq ${segment.from}-${segment.to}) is not in the bucket`,
    );
  }
  return parseSegment(await object.text());
}

/**
 * The journal from `from` (default: the start) to now: the archived segments with events after `from`,
 * fetched on demand, merged with the local journal. A restore to `from` finds its checkpoint in it (a
 * segment's last checkpoint stays local, so a segment ending at `from` is not needed).
 */
export async function readFullJournal(
  sql: JournalSql,
  bucket: ArchiveBucket,
  range: { from?: number } = {},
): Promise<Journal> {
  const from = range.from ?? 0;
  const needed = archivedSegments(sql).filter((segment) => segment.to > from);
  const parts = await Promise.all(needed.map((segment) => fetchSegment(bucket, segment)));
  const local = readJournal(sql);
  // Segments come oldest first, each sorted, then the local rows: a checkpoint both hold keeps its place.
  const checkpoints = new Map<number, JournalCheckpoint>();
  for (const c of [...parts.flatMap((p) => p.checkpoints), ...local.checkpoints]) checkpoints.set(c.seq, c);
  return { events: [...parts.flatMap((p) => p.events), ...local.events], checkpoints: [...checkpoints.values()] };
}

/**
 * Archive everything pruning to `keep` events would remove (the Durable Object calls it after a commit):
 * segment after segment until none is left. Returns the segments written.
 */
export async function archiveDue(
  sql: JournalSql,
  bucket: ArchiveBucket,
  ids: ArchiveIds,
  keep: number,
  now: number,
  atomically: (write: () => void) => void = (write) => write(),
): Promise<ArchivedSegment[]> {
  const upTo = journalHighWater(sql) - keep;
  const written: ArchivedSegment[] = [];
  for (;;) {
    const segment = await archiveJournal(sql, bucket, ids, upTo, now, atomically);
    if (segment === null) return written;
    written.push(segment);
  }
}

function isBucket(value: unknown): value is ArchiveBucket {
  return (
    typeof value === "object" &&
    value !== null &&
    "put" in value &&
    typeof value.put === "function" &&
    "get" in value &&
    typeof value.get === "function"
  );
}

/** The R2 binding `journal.archive` names, from the Worker env. */
export function archiveBucket(env: unknown, name: string): ArchiveBucket {
  const binding = typeof env === "object" && env !== null && name in env ? Reflect.get(env, name) : undefined;
  if (isBucket(binding)) return binding;
  throw new ActorKitError(
    "archive_unbound",
    `journal.archive names "${name}", which is not an R2 bucket binding in the Worker env. Add it to wrangler.jsonc (r2_buckets).`,
  );
}

/** A SQLite-backed Durable Object's storage limit (Workers Paid): 10 GB per object. */
export const STORAGE_CAP_BYTES = 10 * 1024 ** 3;

/** What Studio shows of the journal's storage: where it lives, the object's size, and whether it nears the cap. */
export function journalStorage(stats: ReturnType<typeof journalStats>, storageBytes: number) {
  return { ...stats, storageBytes, capBytes: STORAGE_CAP_BYTES, nearCap: storageBytes >= 0.8 * STORAGE_CAP_BYTES };
}

/** The archived segments that overlap a query's seq window (`from` to the lower of `to` and `before - 1`). */
function segmentsFor(sql: JournalSql, query: JournalQuery): ArchivedSegment[] {
  const low = query.from ?? 0;
  const high = Math.min(query.to ?? Number.POSITIVE_INFINITY, (query.before ?? Number.POSITIVE_INFINITY) - 1);
  return archivedSegments(sql).filter((segment) => segment.to >= low && segment.from <= high);
}

/**
 * The journal query (ADR-019 F) over archived and local rows: the segments that overlap the query's seq
 * window are fetched and filtered like the SQL query filters local rows. Newest-first pages that local
 * rows fill fetch nothing (archived rows are all older).
 */
export async function readArchivedJournalPage(
  sql: JournalSql,
  bucket: ArchiveBucket,
  query: JournalQuery,
  ctx: JournalReadContext,
): Promise<JournalPage> {
  const local = readJournalPage(sql, query, ctx);
  const overlapping = segmentsFor(sql, query);
  // Newest first, a full local page needs nothing older; with no segment in the window, local rows are all.
  if ((query.order === "desc" && local.hasMore) || overlapping.length === 0) return local;
  const archived = (await Promise.all(overlapping.map((segment) => fetchSegment(bucket, segment)))).flatMap(
    (part) => part.events,
  );
  const events = [...archived, ...readJournal(sql).events].filter((event) => matchesJournalQuery(event, query));
  const ordered = query.order === "asc" ? events : events.reverse();
  return {
    entries: ordered.slice(0, query.limit).map((event) => journalEntry(event, ctx)),
    hasMore: ordered.length > query.limit,
  };
}
