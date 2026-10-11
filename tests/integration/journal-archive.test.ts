/**
 * Journal archive to R2 in a real Durable Object (ADR-019 D), with a vitest-pool-workers R2 binding:
 * pruning writes NDJSON segments to the bucket before deleting locally; the archived and local rows read
 * back as the whole journal and replay to the stored state; restore reaches an archived seq; Studio's
 * inspect reports the ranges and the storage. A missing binding archives nothing and deletes nothing.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { archivedSegments, readFullJournal, readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { ArchivedTally } from "./src/archive-actors";

type Stub = DurableObjectStub;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return read();
}

async function tally(binding: "ARCHIVED_TALLY" | "UNBOUND_ARCHIVE", name: string, adds: number): Promise<Stub> {
  const id = `${name}-${Date.now()}`;
  const stub = env[binding].get(env[binding].idFromName(id));
  await stub.spawn({ actorId: id, caller: "clerk", callerType: "service", input: {} });
  for (let n = 1; n <= adds; n++) await stub.send("clerk", "service", { type: "ADD", n });
  return stub;
}

const segments = (stub: Stub) => runInDurableObject(stub, (_i, s) => archivedSegments(s.storage.sql));

describe("journal archive to R2", () => {
  it("archives segments to the bucket before pruning, and reads back the whole journal", async () => {
    const stub = await tally("ARCHIVED_TALLY", "archive", 20);
    const written = await until(
      () => segments(stub),
      // keep 4 at seq 21: pruning cuts at the newest checkpoint at or before 17, which is 16.
      (s) => s.at(-1)?.to === 16,
    );
    expect(written.map((s) => [s.from, s.to])).toEqual(expect.arrayContaining([[1, expect.any(Number)]]));
    const actorId = await runInDurableObject(stub, (_i, s) =>
      String(s.storage.sql.exec("SELECT actor_id FROM snapshots").one()["actor_id"]),
    );
    const listed = await env.JOURNAL_ARCHIVE.list({ prefix: `archived-tally/${actorId}/` });
    expect(listed.objects.map((o) => o.key).sort()).toEqual(written.map((s) => s.key).sort());
    expect(written[0]?.key).toMatch(/^archived-tally\/[^/]+\/1-\d+\.ndjson$/);

    const local = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    expect(local.events.map((e) => e.seq)).toEqual([17, 18, 19, 20, 21]);
    const full = await runInDurableObject(stub, (_i, s) => readFullJournal(s.storage.sql, env.JOURNAL_ARCHIVE));
    expect(full.events.map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    const { state } = await replayJournal(ArchivedTally, full);
    expect(state).toEqual({ total: 210 });
  });

  it("restores to an archived seq, reading its segment from R2", async () => {
    const stub = await tally("ARCHIVED_TALLY", "archive-restore", 12);
    await until(
      () => segments(stub),
      (s) => s.length > 0 && s[0]?.from === 1,
    );
    expect(await stub.__restore({ toSeq: 3 })).toEqual({ ok: true });
    const stored = await runInDurableObject(stub, (_i, s) =>
      JSON.parse(String(s.storage.sql.exec("SELECT state FROM snapshots").one()["state"])),
    );
    expect(stored).toEqual({ total: 3 });
  });

  it("Studio's inspect reports the archived and local ranges and the storage", async () => {
    const stub = await tally("ARCHIVED_TALLY", "archive-inspect", 10);
    await until(
      () => segments(stub),
      (s) => s.at(-1)?.to === 6,
    );
    const inspect = await stub.__inspect();
    expect(inspect.journal?.archived.at(-1)).toMatchObject({ to: 6 });
    expect(inspect.journal?.archived[0]).toMatchObject({ from: 1, bytes: expect.any(Number) });
    expect(inspect.journal).toMatchObject({
      local: { from: 7, to: 11, events: 5 },
      capBytes: 10 * 1024 ** 3,
      nearCap: false,
    });
    expect(inspect.journal?.storageBytes).toBeGreaterThan(0);
  });

  it("without the bucket binding, nothing is archived and nothing is deleted", async () => {
    const stub = await tally("UNBOUND_ARCHIVE", "archive-unbound", 10);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const local = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    expect(local.events).toHaveLength(11);
    expect(await segments(stub)).toEqual([]);
  });
});

describe("the journal query over the archive (ADR-019 F with D)", () => {
  it("__journal pages through archived seqs as if nothing were pruned", async () => {
    const stub = await tally("ARCHIVED_TALLY", "archive-query", 12);
    await until(
      () => segments(stub),
      (s) => s.length > 0,
    );
    const oldest = await stub.__journal({ order: "asc", limit: 3 });
    expect(oldest.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(oldest.hasMore).toBe(true);
    const all = await stub.__journal({ order: "desc", limit: 100 });
    expect(all.entries.map((e) => e.seq)).toEqual(Array.from({ length: 13 }, (_, i) => 13 - i));
    expect(all.entries.at(-1)).toMatchObject({ seq: 1, causeType: "init" });
  });
});
