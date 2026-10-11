/**
 * ADR-019 D: journal archive to R2. Pruning first writes an NDJSON segment (its base checkpoint, the
 * checkpoints inside it, then its events) to the bucket at `actorType/actorId/<fromSeq>-<toSeq>.ndjson`,
 * then deletes those rows locally and records the segment. Readers fetch the segments a range needs.
 * Property tests: for random journals, archive points and restore points, the archived journal gives the
 * same events, state and checksums as one never pruned. On node:sqlite with an in-memory bucket.
 */
import { simulate } from "@actor-kit/test";
import {
  type ArchiveBucket,
  appendJournalEvent,
  archiveBucket,
  archiveDue,
  archivedSegments,
  archiveJournal,
  checksumState,
  defineActor,
  type Journal,
  journalStats,
  journalStorage,
  matchesJournalQuery,
  message,
  parseSegment,
  planRestore,
  prunableRange,
  readArchivedJournalPage,
  readFullJournal,
  readJournal,
  readJournalPage,
  rebuildFromJournal,
  resolveJournalConfig,
  STORAGE_CAP_BYTES,
} from "@actor-kit/worker/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { migratedSql } from "./helpers/journal-sql";
import type { NodeSql } from "./helpers/node-sql";

type S = { n: number; history: number[] };

const Tally = defineActor("tally", {
  input: z.object({}),
  init: (): S => ({ n: 0, history: [] }),
  roles: { any: () => true },
  messages: {
    ADD: message(z.object({ by: z.number() }), (s: S, { by }) => ({ n: s.n + by, history: [...s.history, by] })),
  },
  views: {},
});
const TallyDef = { ...Tally.def, messages: { any: Tally.def.messages } };
const ids = { actorType: "tally", actorId: "t1" };

/** An R2 bucket in memory: put/get, counting reads. */
function memoryBucket() {
  const objects = new Map<string, string>();
  const reads: string[] = [];
  const bucket: ArchiveBucket & { objects: Map<string, string>; reads: string[]; fail: boolean } = {
    objects,
    reads,
    fail: false,
    async put(key, value) {
      if (bucket.fail) throw new Error("R2 is down");
      objects.set(key, value);
      return null;
    },
    async get(key) {
      reads.push(key);
      const text = objects.get(key);
      return text === undefined ? null : { text: async () => text };
    },
  };
  return bucket;
}

let open: NodeSql[] = [];
afterEach(() => {
  for (const sql of open) sql.close();
  open = [];
});

function sqlite(): NodeSql {
  const sql = migratedSql();
  open.push(sql);
  return sql;
}

/** A tally's whole journal from simulate(), checkpointed every `every` transitions. */
async function tallyJournal(adds: readonly number[], every: number): Promise<Journal> {
  const Contract = defineActor("tally", { ...Tally.def, journal: { checkpointEvery: every } });
  const sim = simulate({ contracts: [Contract], now: 100 });
  const actor = await sim.spawn(Contract, "t1", {});
  for (const by of adds) actor.send("u", { type: "ADD", by });
  return actor.journal;
}

function insertEvent(sql: NodeSql, e: Journal["events"][number]): void {
  sql.exec(
    "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    e.seq,
    e.causeType,
    e.name,
    JSON.stringify(e.payload ?? null),
    e.caller,
    e.callerType,
    e.role,
    JSON.stringify(e.facts),
    e.codeVersion,
    e.stateChecksum,
    e.createdAt,
    e.correlationId ?? null,
    e.causationId ?? null,
  );
}

function insertCheckpoint(sql: NodeSql, c: Journal["checkpoints"][number]): void {
  sql.exec(
    "INSERT INTO journal_checkpoints (seq, version, state, checksum, timers) VALUES (?, ?, ?, ?, ?)",
    c.seq,
    c.version,
    c.state,
    c.checksum,
    c.timers ?? "[]",
  );
}

/** Write a journal transition by transition, archiving with `keep` after the transitions in `archiveAt`. */
async function writeArchiving(
  sql: NodeSql,
  bucket: ArchiveBucket,
  journal: Journal,
  keep: number,
  archiveAt: ReadonlySet<number>,
): Promise<void> {
  for (const event of journal.events) {
    insertEvent(sql, event);
    for (const c of journal.checkpoints.filter((c) => c.seq === event.seq)) insertCheckpoint(sql, c);
    if (archiveAt.has(event.seq)) await archiveJournal(sql, bucket, ids, event.seq - keep, 1_000);
  }
}

/** The same journal, never pruned, read back from SQLite (so both sides went through the same rows). */
function unpruned(journal: Journal): Journal {
  const sql = sqlite();
  for (const e of journal.events) insertEvent(sql, e);
  for (const c of journal.checkpoints) insertCheckpoint(sql, c);
  return readJournal(sql);
}

describe("journal: { keep, archive }", () => {
  it("archive names an R2 binding and needs keep", () => {
    expect(resolveJournalConfig({ keep: 10, archive: "JOURNAL" })).toMatchObject({ keep: 10, archive: "JOURNAL" });
    expect(resolveJournalConfig({ keep: 10 })).not.toHaveProperty("archive");
    expect(() => resolveJournalConfig({ archive: "JOURNAL" })).toThrow(
      expect.objectContaining({
        code: "invalid_journal_option",
        message: "journal.archive needs journal.keep: archiving happens when the journal is pruned",
      }),
    );
    expect(() => resolveJournalConfig({ keep: 1, archive: "" })).toThrow(
      expect.objectContaining({ code: "invalid_journal_option", message: "journal.archive must name an R2 binding" }),
    );
  });
});

describe("archiving", () => {
  it("nothing is archivable before a checkpoint at or before the cut", async () => {
    const sql = sqlite();
    expect(prunableRange(sql, 10)).toBeNull();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6], 3);
    for (const e of journal.events) insertEvent(sql, e);
    for (const c of journal.checkpoints) insertCheckpoint(sql, c);
    expect(prunableRange(sql, 2)).toBeNull();
    expect(prunableRange(sql, 5)).toEqual({ from: 1, to: 3 });
    expect(prunableRange(sql, 7)).toEqual({ from: 1, to: 6 });
  });

  it("writes a segment, then deletes it locally and records it", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6], 3);
    for (const e of journal.events) insertEvent(sql, e);
    for (const c of journal.checkpoints) insertCheckpoint(sql, c);

    expect(await archiveJournal(sql, bucket, ids, 4, 1_000)).toEqual({
      from: 1,
      to: 3,
      key: "tally/t1/1-3.ndjson",
      bytes: expect.any(Number),
      archivedAt: 1_000,
    });
    const first = parseSegment(bucket.objects.get("tally/t1/1-3.ndjson") ?? "");
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(first.checkpoints.map((c) => c.seq)).toEqual([3]);
    expect(readJournal(sql).events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(readJournal(sql).checkpoints.map((c) => c.seq)).toEqual([3, 6]);

    expect(await archiveJournal(sql, bucket, ids, 7, 2_000)).toMatchObject({
      from: 4,
      to: 6,
      key: "tally/t1/4-6.ndjson",
    });
    const second = parseSegment(bucket.objects.get("tally/t1/4-6.ndjson") ?? "");
    // A later segment starts from its base checkpoint, so it can be replayed on its own.
    expect(second.checkpoints.map((c) => c.seq)).toEqual([3, 6]);
    expect(second.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(archivedSegments(sql)).toEqual([
      { from: 1, to: 3, key: "tally/t1/1-3.ndjson", bytes: expect.any(Number), archivedAt: 1_000 },
      { from: 4, to: 6, key: "tally/t1/4-6.ndjson", bytes: expect.any(Number), archivedAt: 2_000 },
    ]);
    expect(await archiveJournal(sql, bucket, ids, 7, 3_000)).toBeNull();
  });

  it("deletes nothing when the bucket refuses the segment", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4], 2);
    for (const e of journal.events) insertEvent(sql, e);
    for (const c of journal.checkpoints) insertCheckpoint(sql, c);
    bucket.fail = true;
    await expect(archiveJournal(sql, bucket, ids, 4, 1)).rejects.toThrow("R2 is down");
    expect(readJournal(sql).events).toHaveLength(5);
    expect(archivedSegments(sql)).toEqual([]);
  });

  it("reports the local and archived ranges", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    expect(journalStats(sql)).toEqual({ local: null, archived: [], archivedBytes: 0 });
    const journal = await tallyJournal([1, 2, 3, 4, 5], 2);
    await writeArchiving(sql, bucket, journal, 1, new Set([6]));
    expect(journalStats(sql)).toEqual({
      local: { from: 5, to: 6, events: 2 },
      archived: [{ from: 1, to: 4, bytes: expect.any(Number) }],
      archivedBytes: archivedSegments(sql)[0]?.bytes,
    });
  });
});

describe("reading archived segments", () => {
  it("reads every segment and the local journal back as one journal", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6, 7, 8], 2);
    await writeArchiving(sql, bucket, journal, 2, new Set([4, 7, 9]));
    expect(await readFullJournal(sql, bucket)).toEqual(unpruned(journal));
  });

  it("fetches only the segments a range needs", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6, 7, 8], 2);
    await writeArchiving(sql, bucket, journal, 1, new Set([4, 6, 8, 9]));
    expect(archivedSegments(sql).map((s) => [s.from, s.to])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
    const fromFive = await readFullJournal(sql, bucket, { from: 5 });
    expect(bucket.reads).toEqual(["tally/t1/5-6.ndjson", "tally/t1/7-8.ndjson"]);
    expect(fromFive.events.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(fromFive.checkpoints.map((c) => c.seq)).toEqual([4, 6, 8]);
    expect(await readFullJournal(sql, bucket, { from: 9 })).toEqual(readJournal(sql));
  });

  it("a missing or broken segment fails with a code", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4], 2);
    await writeArchiving(sql, bucket, journal, 1, new Set([4]));
    bucket.objects.clear();
    await expect(readFullJournal(sql, bucket)).rejects.toThrow(
      expect.objectContaining({ code: "archive_missing", message: expect.stringContaining('"tally/t1/1-2.ndjson"') }),
    );
    expect(() => parseSegment('{"kind":"event","row":{}}')).toThrow(
      expect.objectContaining({ code: "invalid_archive_segment" }),
    );
    expect(() => parseSegment("not json")).toThrow(expect.objectContaining({ code: "invalid_archive_segment" }));
    expect(parseSegment("")).toEqual({ events: [], checkpoints: [] });
  });
});

describe("property: archiving changes nothing a reader can see", () => {
  const scenario = fc.record({
    adds: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 40 }),
    every: fc.integer({ min: 1, max: 6 }),
    keep: fc.integer({ min: 1, max: 8 }),
    archiveAt: fc.uniqueArray(fc.integer({ min: 1, max: 41 }), { maxLength: 12 }),
    restoreAt: fc.integer({ min: 1, max: 41 }),
  });

  it("same events, checkpoints, final state and checksums as a journal never pruned", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ adds, every, keep, archiveAt }) => {
        const journal = await tallyJournal(adds, every);
        const sql = sqlite();
        const bucket = memoryBucket();
        await writeArchiving(sql, bucket, journal, keep, new Set(archiveAt));
        const merged = await readFullJournal(sql, bucket);
        const whole = unpruned(journal);
        expect(merged).toEqual(whole);
        const state = await rebuildFromJournal(TallyDef, merged);
        expect(checksumState(TallyDef, state)).toBe(whole.events.at(-1)?.stateChecksum);
        expect(state).toEqual(await rebuildFromJournal(TallyDef, whole));
      }),
      { numRuns: 60 },
    );
  });

  it("a restore to any seq gives the state an unpruned journal gives", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ adds, every, keep, archiveAt, restoreAt }) => {
        const journal = await tallyJournal(adds, every);
        const toSeq = Math.min(restoreAt, journal.events.length);
        const sql = sqlite();
        const bucket = memoryBucket();
        await writeArchiving(sql, bucket, journal, keep, new Set(archiveAt));
        const reaching = await readFullJournal(sql, bucket, { from: toSeq });
        const archived = await planRestore(TallyDef, reaching, toSeq);
        const whole = await planRestore(TallyDef, unpruned(journal), toSeq);
        expect(archived.state).toEqual(whole.state);
        expect(checksumState(TallyDef, archived.state)).toBe(
          journal.events.find((e) => e.seq === toSeq)?.stateChecksum,
        );
      }),
      { numRuns: 60 },
    );
  });
});

describe("the runtime's side", () => {
  it("archiveDue archives segment after segment until the journal is down to keep", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6, 7, 8], 2);
    for (const e of journal.events) insertEvent(sql, e);
    for (const c of journal.checkpoints) insertCheckpoint(sql, c);
    const writes: string[] = [];
    const segments = await archiveDue(sql, bucket, ids, 3, 5, (write) => {
      writes.push("tx");
      write();
    });
    expect(segments.map((s) => [s.from, s.to])).toEqual([[1, 6]]);
    expect(writes).toEqual(["tx"]);
    expect(await archiveDue(sql, bucket, ids, 3, 6)).toEqual([]);
    expect(readJournal(sql).events.map((e) => e.seq)).toEqual([7, 8, 9]);
  });

  it("archiveBucket finds the R2 binding, or says what is wrong", () => {
    const bucket = memoryBucket();
    expect(archiveBucket({ JOURNAL: bucket }, "JOURNAL")).toBe(bucket);
    for (const env of [{}, { JOURNAL: "x" }, { JOURNAL: { put: () => null } }, null]) {
      expect(() => archiveBucket(env, "JOURNAL")).toThrow(
        expect.objectContaining({
          code: "archive_unbound",
          message:
            'journal.archive names "JOURNAL", which is not an R2 bucket binding in the Worker env. Add it to wrangler.jsonc (r2_buckets).',
        }),
      );
    }
  });

  it("journalStorage warns at 80% of the per-object storage cap", () => {
    const stats = { local: null, archived: [], archivedBytes: 0 };
    expect(STORAGE_CAP_BYTES).toBe(10 * 1024 ** 3);
    expect(journalStorage(stats, 1000)).toEqual({
      ...stats,
      storageBytes: 1000,
      capBytes: STORAGE_CAP_BYTES,
      nearCap: false,
    });
    expect(journalStorage(stats, 0.8 * STORAGE_CAP_BYTES).nearCap).toBe(true);
    expect(journalStorage(stats, 0.8 * STORAGE_CAP_BYTES - 1).nearCap).toBe(false);
  });
});

describe("archive edges", () => {
  it("with an archive, appending never prunes inline: the rows wait for their segment", () => {
    const write = (sql: NodeSql, config: ReturnType<typeof resolveJournalConfig>) => {
      for (let seq = 1; seq <= 6; seq++) {
        const draft = {
          causeType: "message" as const,
          name: "ADD",
          payload: {},
          caller: null,
          callerType: null,
          role: null,
          facts: {},
        };
        appendJournalEvent(sql, config, draft, { seq, stateJson: "{}", checksum: "c", version: 1, now: 0 });
      }
      return readJournal(sql).events.map((e) => e.seq);
    };
    expect(write(sqlite(), resolveJournalConfig({ keep: 2, checkpointEvery: 1 }))).toEqual([5, 6]);
    expect(write(sqlite(), resolveJournalConfig({ keep: 2, checkpointEvery: 1, archive: "R2" }))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("archives one-event segments when every transition is a checkpoint", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3], 1);
    await writeArchiving(sql, bucket, journal, 1, new Set([2, 3, 4]));
    expect(archivedSegments(sql).map((s) => [s.from, s.to])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(await readFullJournal(sql, bucket)).toEqual(unpruned(journal));
  });

  it("archiveDue writes with its default transaction too", async () => {
    const sql = sqlite();
    const journal = await tallyJournal([1, 2, 3, 4], 2);
    for (const e of journal.events) insertEvent(sql, e);
    for (const c of journal.checkpoints) insertCheckpoint(sql, c);
    expect(await archiveDue(sql, memoryBucket(), ids, 1, 7)).toHaveLength(1);
    expect(readJournal(sql).events.map((e) => e.seq)).toEqual([5]);
  });

  it("a range ending where a segment ends needs only what comes after it", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6, 7, 8], 2);
    await writeArchiving(sql, bucket, journal, 1, new Set([4, 6, 8, 9]));
    const fromSix = await readFullJournal(sql, bucket, { from: 6 });
    expect(bucket.reads).toEqual(["tally/t1/7-8.ndjson"]);
    expect(fromSix.checkpoints.map((c) => c.seq)).toEqual([6, 8]);
    const restored = await planRestore(TallyDef, fromSix, 6);
    expect(restored.state).toEqual({ n: 15, history: [1, 2, 3, 4, 5] });
  });

  it("a broken line is named by its number", () => {
    expect(() =>
      parseSegment('{"kind":"checkpoint","row":{"seq":1,"version":1,"state":"{}","checksum":"c"}}\nnope'),
    ).toThrow(/^Archived journal segment line 2 is invalid: /);
  });

  it("archiveBucket refuses anything that is not a bucket", () => {
    const noBucket = expect.objectContaining({ code: "archive_unbound" });
    const fn = async () => null;
    for (const env of ["x", { JOURNAL: null }, { JOURNAL: { put: 1, get: fn } }, { JOURNAL: { put: fn, get: 1 } }]) {
      expect(() => archiveBucket(env, "JOURNAL")).toThrow(noBucket);
    }
  });
});

describe("the journal query reads archived segments (ADR-019 D with F)", () => {
  const ctx = {
    published: new Set<string>(),
    eventId: (seq: number) => `tally/t1/${seq}`,
    sourceType: (l: string) => l,
  };
  const query = fc.record(
    {
      from: fc.integer({ min: 0, max: 30 }),
      to: fc.integer({ min: 0, max: 30 }),
      before: fc.integer({ min: 0, max: 30 }),
      causeType: fc.constantFrom("init" as const, "message" as const),
      limit: fc.integer({ min: 1, max: 12 }),
      order: fc.constantFrom("asc" as const, "desc" as const),
    },
    { requiredKeys: ["limit", "order"] },
  );

  it("a page over archived and local rows equals the page over a journal never pruned", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 4 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 26 }), { maxLength: 8 }),
        query,
        async (adds, every, archiveAt, q) => {
          const journal = await tallyJournal(adds, every);
          const sql = sqlite();
          const bucket = memoryBucket();
          await writeArchiving(sql, bucket, journal, 2, new Set(archiveAt));
          const whole = sqlite();
          for (const e of journal.events) insertEvent(whole, e);
          expect(await readArchivedJournalPage(sql, bucket, q, ctx)).toEqual(readJournalPage(whole, q, ctx));
        },
      ),
      { numRuns: 80 },
    );
  });

  it("fetches no segment when the page is all local", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6], 2);
    await writeArchiving(sql, bucket, journal, 2, new Set([7])); // archived 1-4, local 5-7
    const page = await readArchivedJournalPage(sql, bucket, { limit: 1, order: "desc" }, ctx);
    expect(page.entries.map((e) => e.seq)).toEqual([7]);
    expect(page.hasMore).toBe(true);
    expect(bucket.reads).toEqual([]);
  });
});

describe("journal query filters on events read from R2", () => {
  const base = {
    seq: 5,
    causeType: "message" as const,
    name: "ADD",
    payload: {},
    caller: null,
    callerType: null,
    role: null,
    facts: {},
    codeVersion: 1,
    stateChecksum: "c",
    createdAt: 0,
    correlationId: "a/1/5",
    emitted: [{ name: "Added", payload: {} }],
  };
  const q = { limit: 10, order: "asc" as const };

  it.each([
    [{}, true],
    [{ from: 5 }, true],
    [{ from: 6 }, false],
    [{ to: 5 }, true],
    [{ to: 4 }, false],
    [{ before: 6 }, true],
    [{ before: 5 }, false],
    [{ causeType: "message" as const }, true],
    [{ causeType: "timer" as const }, false],
    [{ correlationId: "a/1/5" }, true],
    [{ correlationId: "a/1/4" }, false],
    [{ event: "Added" }, true],
    [{ event: "Removed" }, false],
  ])("%j matches: %s", (filter, expected) => {
    expect(matchesJournalQuery(base, { ...q, ...filter })).toBe(expected);
  });

  it("an event that emitted nothing matches no event filter", () => {
    const { emitted: _emitted, ...silent } = base;
    expect(matchesJournalQuery(silent, { ...q, event: "Added" })).toBe(false);
    expect(matchesJournalQuery(silent, q)).toBe(true);
  });

  it("pages oldest first across archived and local rows, and says when more remain", async () => {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6], 2);
    await writeArchiving(sql, bucket, journal, 2, new Set([7])); // archived 1-4, local 5-7
    const ctx = { published: new Set<string>(), eventId: (seq: number) => `t/${seq}`, sourceType: (l: string) => l };
    const first = await readArchivedJournalPage(sql, bucket, { limit: 3, order: "asc" }, ctx);
    expect(first.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(first.hasMore).toBe(true);
    const newest = await readArchivedJournalPage(sql, bucket, { limit: 5, order: "desc" }, ctx);
    expect(newest.entries.map((e) => e.seq)).toEqual([7, 6, 5, 4, 3]);
    expect(newest.entries[0]).toMatchObject({ id: "t/7", causeType: "message", checksum: expect.any(String) });
    const rest = await readArchivedJournalPage(sql, bucket, { limit: 5, order: "desc", before: 3 }, ctx);
    expect(rest).toMatchObject({ hasMore: false });
    expect(rest.entries.map((e) => e.seq)).toEqual([2, 1]);
    bucket.reads.length = 0;
    await readArchivedJournalPage(sql, bucket, { limit: 5, order: "asc", from: 5 }, ctx);
    await readArchivedJournalPage(sql, bucket, { limit: 5, order: "asc", to: 0 }, ctx);
    expect(bucket.reads).toEqual([]);
    await readArchivedJournalPage(sql, bucket, { limit: 5, order: "asc", to: 4, before: 9 }, ctx);
    expect(bucket.reads).toEqual(["tally/t1/1-4.ndjson"]);
  });
});

describe("journal query windows", () => {
  const ctx = { published: new Set<string>(), eventId: (seq: number) => `t/${seq}`, sourceType: (l: string) => l };
  async function twoSegments() {
    const sql = sqlite();
    const bucket = memoryBucket();
    const journal = await tallyJournal([1, 2, 3, 4, 5, 6], 2);
    await writeArchiving(sql, bucket, journal, 1, new Set([4, 6])); // archived 1-2, 3-4; local 5-7
    bucket.reads.length = 0;
    return { sql, bucket };
  }

  it("fetches only the segments the window reaches", async () => {
    const { sql, bucket } = await twoSegments();
    await readArchivedJournalPage(sql, bucket, { limit: 9, order: "asc", before: 3 }, ctx);
    expect(bucket.reads).toEqual(["tally/t1/1-2.ndjson"]);
    const fromTwo = await readArchivedJournalPage(sql, bucket, { limit: 1, order: "asc", from: 2 }, ctx);
    expect(fromTwo.entries.map((e) => e.seq)).toEqual([2]);
  });

  it("oldest first never stops at a full local page; hasMore is exact", async () => {
    const { sql, bucket } = await twoSegments();
    const oldest = await readArchivedJournalPage(sql, bucket, { limit: 2, order: "asc" }, ctx);
    expect(oldest.entries.map((e) => e.seq)).toEqual([1, 2]);
    const exact = await readArchivedJournalPage(sql, bucket, { limit: 2, order: "desc", before: 3 }, ctx);
    expect(exact).toMatchObject({ hasMore: false });
    expect(exact.entries.map((e) => e.seq)).toEqual([2, 1]);
  });
});
