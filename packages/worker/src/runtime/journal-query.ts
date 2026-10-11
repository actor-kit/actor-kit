/**
 * The journal query (ADR-019 F): journal events filtered by seq range, cause type, emitted event
 * name and correlation id, newest first (or oldest first), one page at a time.
 *
 * An entry is the event's cause in the Studio cause shape (journal-timeline.ts), the domain events
 * it emitted (each marked when `publish` sends it), its causation and correlation ids and its
 * checksum. No after-state: that is the timeline's job. Pure over the structural `JournalSql`: the
 * Durable Object reads, then projects (redacts, hashes callers) each entry through
 * studio-project.ts before it leaves (ADR-014).
 */

import { ActorKitError } from "@actor-kit/core";
import { z } from "zod";
import { JOURNAL_CAUSE_TYPES, JOURNAL_EVENT_COLUMNS, type JournalSql, parseJournalEventRow } from "./journal";
import { timelineCause } from "./journal-timeline";

export const JOURNAL_QUERY_MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

const seq = z.number().int().nonnegative();

const JournalOptionsSchema = z
  .object({
    /** Inclusive lower seq bound. */
    from: seq.optional(),
    /** Inclusive upper seq bound. */
    to: seq.optional(),
    /** Exclusive upper seq bound: the cursor for older pages (newest first). */
    before: seq.optional(),
    causeType: z.enum(JOURNAL_CAUSE_TYPES).optional(),
    /** Only events that emitted a domain event with this name. */
    event: z.string().min(1).max(256).optional(),
    correlationId: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(JOURNAL_QUERY_MAX_LIMIT).default(DEFAULT_LIMIT),
    /** desc (default): newest first, page with `before`. asc: oldest first, page with `from`. */
    order: z.enum(["asc", "desc"]).default("desc"),
    viewer: z.enum(["human", "agent"]).default("human"),
  })
  .strict();

/** What the RPC accepts (every field optional). */
export type JournalOptions = z.input<typeof JournalOptionsSchema>;
export type JournalQuery = Omit<z.output<typeof JournalOptionsSchema>, "viewer">;

/** Parse the RPC's options at the boundary. Throws on anything else. */
export function parseJournalOptions(opts: unknown): { query: JournalQuery; viewer: "human" | "agent" } {
  const parsed = JournalOptionsSchema.safeParse(opts ?? {});
  if (!parsed.success)
    throw new ActorKitError("invalid_journal_query", `Invalid journal query: ${parsed.error.message}`);
  const { viewer, ...query } = parsed.data;
  return { query, viewer };
}

export interface JournalEntryEmitted {
  readonly name: string;
  readonly payload: unknown;
  /** Whether `publish` sends this event to the actor's Queue. */
  readonly published: boolean;
}

export interface JournalEntry {
  /** `${actorType}/${actorId}/${seq}`: what an effect's or a published event's causationId names. */
  readonly id: string;
  readonly seq: number;
  readonly causeType: string;
  /** The cause in the Studio shape (message type, caller, role, payload; service input/result; ...). */
  readonly cause: Record<string, unknown>;
  readonly emitted: readonly JournalEntryEmitted[];
  /** Null for events written before ADR-017. */
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly createdAt: number;
  readonly codeVersion: number;
  /** Checksum of the state after this event. */
  readonly checksum: string;
}

export interface JournalPage {
  readonly entries: JournalEntry[];
  readonly hasMore: boolean;
}

/** What reading entries needs besides storage. */
export interface JournalReadContext {
  /** Names of the events `publish` sends. */
  readonly published: ReadonlySet<string>;
  eventId(seq: number): string;
  /** The source actor type Studio shows for a link. */
  sourceType(link: string): string;
}

/** WHERE clauses for the filters that are set, with their bindings in order. */
function filters(query: JournalQuery): { where: string; bindings: (string | number)[] } {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  const add = (clause: string, value: string | number | undefined) => {
    if (value === undefined) return;
    clauses.push(clause);
    bindings.push(value);
  };
  add("seq >= ?", query.from);
  add("seq <= ?", query.to);
  add("seq < ?", query.before);
  add("cause_type = ?", query.causeType);
  add("correlation_id = ?", query.correlationId);
  add("EXISTS (SELECT 1 FROM json_each(events.emitted) WHERE json_extract(value, '$.name') = ?)", query.event);
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, bindings };
}

/** One page of journal entries matching the query (raw: project each entry before it leaves the DO). */
export function readJournalPage(sql: JournalSql, query: JournalQuery, ctx: JournalReadContext): JournalPage {
  const { where, bindings } = filters(query);
  const order = query.order === "asc" ? "ASC" : "DESC";
  const rows = sql
    .exec(
      `SELECT ${JOURNAL_EVENT_COLUMNS} FROM events ${where} ORDER BY seq ${order} LIMIT ?`,
      ...bindings,
      query.limit + 1,
    )
    .toArray();
  const entries = rows.slice(0, query.limit).map((row) => {
    const event = parseJournalEventRow(row);
    return {
      id: ctx.eventId(event.seq),
      seq: event.seq,
      causeType: event.causeType,
      cause: timelineCause(event, ctx.sourceType),
      emitted: (event.emitted ?? []).map((e) => ({ ...e, published: ctx.published.has(e.name) })),
      correlationId: event.correlationId ?? null,
      causationId: event.causationId ?? null,
      createdAt: event.createdAt,
      codeVersion: event.codeVersion,
      checksum: event.stateChecksum,
    };
  });
  return { entries, hasMore: rows.length > query.limit };
}
