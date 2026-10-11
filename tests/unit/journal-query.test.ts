/**
 * ADR-019 F: the journal query. Filters (seq range, cause type, emitted event name, correlation id),
 * order, cursor and limit over the `events` table; entries carry the Studio cause shape, emitted
 * events (marked when `publish` sends them), causation and correlation ids. Real SQLite (node:sqlite).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  JOURNAL_QUERY_MAX_LIMIT,
  parseJournalOptions,
  readJournalPage,
} from "../../packages/worker/src/runtime/journal-query";
import { migratedSql } from "./helpers/journal-sql";
import type { NodeSql } from "./helpers/node-sql";

let sql: NodeSql | undefined;
afterEach(() => {
  sql?.close();
  sql = undefined;
});

interface Row {
  seq: number;
  causeType?: string;
  name?: string | null;
  payload?: unknown;
  caller?: string | null;
  role?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  emitted?: Array<{ name: string; payload: unknown }> | null;
}

function insert(db: NodeSql, row: Row): void {
  db.exec(
    "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at, correlation_id, causation_id, emitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.seq,
    row.causeType ?? "message",
    row.name ?? null,
    JSON.stringify(row.payload ?? {}),
    row.caller ?? null,
    row.caller === undefined ? null : "user",
    row.role ?? null,
    "{}",
    1,
    `sum${row.seq}`,
    1000 + row.seq,
    row.correlationId ?? null,
    row.causationId ?? null,
    row.emitted == null ? null : JSON.stringify(row.emitted),
  );
}

const ctx = {
  published: new Set(["Sold"]),
  eventId: (seq: number) => `lot/l1/${seq}`,
  sourceType: (link: string) => link.toLowerCase(),
};

/** A lot's journal: init, two bids (one emits Outbid), a timer that emits Sold and Closed, then a late bid. */
function lot(): NodeSql {
  const db = migratedSql();
  insert(db, { seq: 1, causeType: "init", payload: { reserve: 5 }, correlationId: "lot/l1/1" });
  insert(db, {
    seq: 2,
    name: "BID",
    payload: { amount: 10 },
    caller: "ann",
    role: "bidder",
    correlationId: "lot/l1/2",
  });
  insert(db, {
    seq: 3,
    name: "BID",
    payload: { amount: 12 },
    caller: "bo",
    role: "bidder",
    correlationId: "lot/l1/3",
    emitted: [{ name: "Outbid", payload: { who: "ann" } }],
  });
  insert(db, {
    seq: 4,
    causeType: "timer",
    name: "close",
    payload: { key: "close", payload: null, fireAt: 50, lateBy: 0 },
    correlationId: "lot/l1/3",
    causationId: "lot/l1/3:0",
    emitted: [
      { name: "Sold", payload: { to: "bo", amount: 12 } },
      { name: "Closed", payload: {} },
    ],
  });
  insert(db, { seq: 5, name: "BID", payload: { amount: 13 }, caller: "cy", role: "bidder", correlationId: "lot/l1/5" });
  sql = db;
  return db;
}

const seqs = (page: { entries: Array<{ seq: number }> }) => page.entries.map((e) => e.seq);
const query = (opts: unknown) => readJournalPage(lot(), parseJournalOptions(opts).query, ctx);

describe("readJournalPage", () => {
  it("returns entries newest first by default, with ids, causes, emitted events and trace ids", () => {
    const page = query({ limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.entries).toEqual([
      {
        id: "lot/l1/5",
        seq: 5,
        causeType: "message",
        cause: { messageType: "BID", caller: "cy", callerType: "user", role: "bidder", payload: { amount: 13 } },
        emitted: [],
        correlationId: "lot/l1/5",
        causationId: null,
        createdAt: 1005,
        codeVersion: 1,
        checksum: "sum5",
      },
      {
        id: "lot/l1/4",
        seq: 4,
        causeType: "timer",
        cause: { name: "close", key: "close", payload: null, fireAt: 50, lateBy: 0 },
        emitted: [
          { name: "Sold", payload: { to: "bo", amount: 12 }, published: true },
          { name: "Closed", payload: {}, published: false },
        ],
        correlationId: "lot/l1/3",
        causationId: "lot/l1/3:0",
        createdAt: 1004,
        codeVersion: 1,
        checksum: "sum4",
      },
    ]);
  });

  it("pages older entries with an exclusive before cursor", () => {
    expect(seqs(query({ limit: 2, before: 4 }))).toEqual([3, 2]);
    const last = query({ limit: 2, before: 2 });
    expect(seqs(last)).toEqual([1]);
    expect(last.hasMore).toBe(false);
  });

  it("reads oldest first with order asc, paging with from", () => {
    const first = query({ order: "asc", limit: 2 });
    expect(seqs(first)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const rest = query({ order: "asc", from: 3, limit: 5 });
    expect(seqs(rest)).toEqual([3, 4, 5]);
    expect(rest.hasMore).toBe(false);
  });

  it("has no more when the page holds exactly the rest", () => {
    const page = query({ limit: 5 });
    expect(seqs(page)).toEqual([5, 4, 3, 2, 1]);
    expect(page.hasMore).toBe(false);
  });

  it("filters by an inclusive seq range", () => {
    expect(seqs(query({ from: 2, to: 4 }))).toEqual([4, 3, 2]);
    expect(seqs(query({ to: 1 }))).toEqual([1]);
    expect(seqs(query({ from: 5 }))).toEqual([5]);
  });

  it("filters by cause type", () => {
    expect(seqs(query({ causeType: "message" }))).toEqual([5, 3, 2]);
    expect(seqs(query({ causeType: "timer" }))).toEqual([4]);
    expect(seqs(query({ causeType: "restore" }))).toEqual([]);
  });

  it("filters by the name of an emitted event", () => {
    expect(seqs(query({ event: "Sold" }))).toEqual([4]);
    expect(seqs(query({ event: "Outbid" }))).toEqual([3]);
    expect(seqs(query({ event: "Missing" }))).toEqual([]);
  });

  it("filters by correlation id (a flow and what it caused)", () => {
    expect(seqs(query({ correlationId: "lot/l1/3" }))).toEqual([4, 3]);
  });

  it("combines filters", () => {
    expect(seqs(query({ correlationId: "lot/l1/3", causeType: "message" }))).toEqual([3]);
    expect(seqs(query({ from: 3, causeType: "message", order: "asc" }))).toEqual([3, 5]);
  });

  it("returns an empty page for a journal with no events", () => {
    sql = migratedSql();
    expect(readJournalPage(sql, parseJournalOptions({}).query, ctx)).toEqual({ entries: [], hasMore: false });
  });

  it("reports null trace ids for events written before ADR-017", () => {
    const db = migratedSql();
    sql = db;
    insert(db, { seq: 1, causeType: "init" });
    const [entry] = readJournalPage(db, parseJournalOptions({}).query, ctx).entries;
    expect(entry).toMatchObject({ correlationId: null, causationId: null, emitted: [] });
  });
});

describe("parseJournalOptions", () => {
  it("defaults to the newest 100, human viewer", () => {
    expect(parseJournalOptions(undefined)).toEqual({ query: { limit: 100, order: "desc" }, viewer: "human" });
  });

  it("keeps every filter and the viewer", () => {
    const opts = {
      from: 1,
      to: 9,
      before: 8,
      causeType: "timer",
      event: "Sold",
      correlationId: "lot/l1/3",
      limit: 5,
      order: "asc",
      viewer: "agent",
    };
    const { viewer, ...query } = opts;
    expect(parseJournalOptions(opts)).toEqual({ query, viewer });
  });

  it.each([
    [{ limit: 0 }, "limit"],
    [{ limit: JOURNAL_QUERY_MAX_LIMIT + 1 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ from: -1 }, "from"],
    [{ to: -1 }, "to"],
    [{ before: -1 }, "before"],
    [{ causeType: "nope" }, "causeType"],
    [{ event: "" }, "event"],
    [{ correlationId: "" }, "correlationId"],
    [{ order: "up" }, "order"],
    [{ viewer: "robot" }, "viewer"],
    [{ unknown: 1 }, "unknown"],
    ["text", "expected object"],
  ])("rejects %j", (opts, mentioned) => {
    expect(() => parseJournalOptions(opts)).toThrow(/Invalid journal query/);
    expect(() => parseJournalOptions(opts)).toThrow(mentioned);
  });

  it("accepts desc and the human viewer by name", () => {
    expect(parseJournalOptions({ order: "desc", viewer: "human" })).toEqual({
      query: { limit: 100, order: "desc" },
      viewer: "human",
    });
  });

  it("accepts the largest limit", () => {
    expect(parseJournalOptions({ limit: JOURNAL_QUERY_MAX_LIMIT }).query.limit).toBe(JOURNAL_QUERY_MAX_LIMIT);
  });
});
