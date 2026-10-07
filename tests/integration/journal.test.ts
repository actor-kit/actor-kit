/**
 * Actor journal (ADR-013, step 1): every persisted transition appends one event in the same
 * transaction as the state, with the facts its handler read.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { xxh64 } from "@actor-kit/core";
import { type Journal, type JournalEvent, readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JOURNAL_PROBE_VERSION, JournalProbe, type JournalProbeState } from "./src/journal-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

type Stub = DurableObjectStub;

function probe(name: string) {
  return env.JOURNAL_PROBE.get(env.JOURNAL_PROBE.idFromName(name));
}

async function spawnProbe(prefix: string) {
  const name = unique(prefix);
  const stub = probe(name);
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: { owner: "olive" } });
  return stub;
}

const SnapshotRow = z.object({ state: z.string(), checksum: z.string(), version: z.number() });

async function storage(stub: Stub): Promise<{ journal: Journal; snapshot: z.infer<typeof SnapshotRow> }> {
  return runInDurableObject(stub, (_instance, state) => ({
    journal: readJournal(state.storage.sql),
    snapshot: SnapshotRow.parse(state.storage.sql.exec("SELECT state, checksum, version FROM snapshots").one()),
  }));
}

function last(journal: Journal): JournalEvent {
  const event = journal.events.at(-1);
  if (event === undefined) throw new Error("journal is empty");
  return event;
}

function probeState(json: string): JournalProbeState {
  return z
    .object({
      owner: z.string(),
      createdAt: z.number(),
      notes: z.array(z.object({ id: z.string(), text: z.string(), at: z.number(), roll: z.number() })),
      connects: z.array(z.string()),
      disconnects: z.array(z.string()),
      results: z.array(z.unknown()),
      errors: z.array(z.string()),
      linkViews: z.array(z.object({ id: z.string(), keys: z.array(z.string()), at: z.number() })),
      linkErrors: z.array(z.string()),
      unlinked: z.array(z.string()),
      migratedFrom: z.number(),
    })
    .parse(JSON.parse(json));
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function waitForEvent(stub: Stub, causeType: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = await storage(stub);
    if (s.journal.events.some((e) => e.causeType === causeType)) return s;
    if (Date.now() > deadline) throw new Error(`no ${causeType} event: ${JSON.stringify(s.journal.events)}`);
    await settle();
  }
}

/** The snapshot is always the after-state of the newest event. */
function expectSnapshotMatchesJournal(s: { journal: Journal; snapshot: { state: string; checksum: string } }) {
  expect(s.snapshot.checksum).toBe(xxh64(s.snapshot.state));
  expect(last(s.journal).stateChecksum).toBe(s.snapshot.checksum);
}

async function connect(stub: Stub, caller: string) {
  const res = await stub.fetch("http://localhost/ws", {
    headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": caller, "X-Actor-Kit-Caller-Type": "user" },
  });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  return ws;
}

describe("journal: one event per persisted transition", () => {
  it("spawn appends an init event with the parsed input and the facts init read", async () => {
    const stub = await spawnProbe("j-init");
    const s = await storage(stub);
    expect(s.journal.events).toHaveLength(1);
    const init = last(s.journal);
    expect(init).toMatchObject({
      seq: 1,
      causeType: "init",
      name: null,
      payload: { owner: "olive" },
      codeVersion: JOURNAL_PROBE_VERSION,
    });
    expect(init.facts).toEqual({ now: probeState(s.snapshot.state).createdAt });
    expectSnapshotMatchesJournal(s);
  });

  it("a message records its parsed payload, caller, role and every fact the handler read", async () => {
    const stub = await spawnProbe("j-msg");
    expect(await stub.send("alice", "user", { type: "NOTE", text: "hi" })).toEqual({ ok: true });
    const s = await storage(stub);
    const event = last(s.journal);
    const note = probeState(s.snapshot.state).notes[0];
    expect(event).toMatchObject({
      seq: 2,
      causeType: "message",
      name: "NOTE",
      payload: { text: "hi" },
      caller: "alice",
      callerType: "user",
      role: "user",
    });
    expect(event.facts).toEqual({ now: note?.at, ids: [note?.id], randoms: [note?.roll] });
    expectSnapshotMatchesJournal(s);
  });

  it("a rejected message appends nothing", async () => {
    const stub = await spawnProbe("j-reject");
    const result = await stub.send("alice", "user", { type: "NOTE", text: "" });
    expect(result.ok).toBe(false);
    expect((await storage(stub)).journal.events.map((e) => e.causeType)).toEqual(["init"]);
  });

  it("connect and disconnect append lifecycle events", async () => {
    const stub = await spawnProbe("j-life");
    const ws = await connect(stub, "bob");
    const afterConnect = await waitForEvent(stub, "lifecycle.connect");
    const connectEvent = last(afterConnect.journal);
    expect(connectEvent).toMatchObject({
      causeType: "lifecycle.connect",
      caller: "bob",
      callerType: "user",
      role: "user",
    });
    expect(probeState(afterConnect.snapshot.state).connects).toEqual([`bob@${connectEvent.facts.now}`]);

    ws.close(1000, "bye");
    const afterDisconnect = await waitForEvent(stub, "lifecycle.disconnect");
    expect(last(afterDisconnect.journal)).toMatchObject({
      causeType: "lifecycle.disconnect",
      caller: "bob",
      callerType: "user",
    });
    expectSnapshotMatchesJournal(afterDisconnect);
  });

  it("service.onDone records the input and result as its payload", async () => {
    const stub = await spawnProbe("j-done");
    await stub.send("alice", "user", { type: "FETCH", q: "x" });
    const s = await waitForEvent(stub, "service.onDone");
    const event = last(s.journal);
    expect(event).toMatchObject({
      causeType: "service.onDone",
      name: "ECHO",
      payload: { input: { q: "x" }, result: { echo: { q: "x" } } },
    });
    expect(event.facts.now).toBeTypeOf("number");
    expectSnapshotMatchesJournal(s);
  });

  it("service.onError records the input and error", async () => {
    const stub = await spawnProbe("j-err");
    await stub.send("alice", "user", { type: "FAIL", q: "y" });
    const s = await waitForEvent(stub, "service.onError");
    expect(last(s.journal)).toMatchObject({
      causeType: "service.onError",
      name: "BOOM",
      payload: { input: { q: "y" }, error: { message: "boom" } },
    });
    expectSnapshotMatchesJournal(s);
  });

  it("link.onUpdate records the source and the view it received", async () => {
    const stub = await spawnProbe("j-update");
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO active_links (target_type, target_id, link_name, version, created_at) VALUES ('NOT_AN_ACTOR', 'r1', 'room', 0, 0)",
      );
    });
    await stub.__receiveLinkUpdate("NOT_AN_ACTOR", "r1", { topic: "t" }, "member", 5);
    const s = await storage(stub);
    const event = last(s.journal);
    expect(event).toMatchObject({
      causeType: "link.onUpdate",
      name: "room",
      payload: { sourceId: "r1", view: { topic: "t", role: "member" } },
    });
    expect(probeState(s.snapshot.state).linkViews).toEqual([
      { id: "r1", keys: ["role", "topic"], at: event.facts.now },
    ]);
    expectSnapshotMatchesJournal(s);
  });

  it("link.onError records the target and error when subscribing fails", async () => {
    const stub = await spawnProbe("j-linkerr");
    await stub.send("alice", "user", { type: "LINK", id: "r9" });
    const s = await waitForEvent(stub, "link.onError");
    expect(last(s.journal)).toMatchObject({
      causeType: "link.onError",
      name: "room",
      payload: { targetId: "r9", error: { code: "unreachable" } },
    });
    expect(probeState(s.snapshot.state).linkErrors).toEqual(["r9:unreachable"]);
    expectSnapshotMatchesJournal(s);
  });

  it("unlink(name) records the targets it removed, and the snapshot includes onUnlink's state", async () => {
    const stub = await spawnProbe("j-unlink");
    await runInDurableObject(stub, (_i, state) => {
      for (const id of ["r1", "r2"]) {
        state.storage.sql.exec(
          "INSERT INTO active_links (target_type, target_id, link_name, version, created_at) VALUES ('NOT_AN_ACTOR', ?, 'room', 0, 0)",
          id,
        );
      }
    });
    await stub.send("alice", "user", { type: "UNLINK_ALL" });
    const s = await storage(stub);
    expect(last(s.journal).facts).toEqual({ unlinked: [{ name: "room", ids: ["r1", "r2"] }] });
    expect(probeState(s.snapshot.state).unlinked).toEqual(["r1", "r2"]);
    expectSnapshotMatchesJournal(s);
  });

  it("a migration on wake appends a migrate event", async () => {
    const name = unique("j-migrate");
    const stub = probe(name);
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: { owner: "olive" } });
    const s = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE snapshots SET version = 1");
      await new JournalProbe(state, env).getSnapshot("alice", "user");
      return { journal: readJournal(state.storage.sql) };
    });
    expect(last(s.journal)).toMatchObject({
      causeType: "migrate",
      payload: { fromVersion: 1, toVersion: JOURNAL_PROBE_VERSION },
    });
  });

  it("auto-spawn appends an init event", async () => {
    const stub = env.JOURNAL_KEEP.get(env.JOURNAL_KEEP.idFromName(unique("j-auto")));
    await stub.send("alice", "user", { type: "INC" });
    const s = await storage(stub);
    expect(s.journal.events.map((e) => e.causeType)).toEqual(["init", "message"]);
    expectSnapshotMatchesJournal(s);
  });
});

describe("journal: transitions are atomic", () => {
  it("service.onDone: if the event can't be written, neither is the state", async () => {
    const stub = await spawnProbe("j-atomic-done");
    await stub.send("alice", "user", { type: "BIG" });
    await settle(100);
    const s = await storage(stub);
    expect(s.journal.events.map((e) => e.causeType)).toEqual(["init", "message"]);
    expect(probeState(s.snapshot.state).results).toEqual([]);
    expectSnapshotMatchesJournal(s);
    expect(await stub.getSnapshot("alice", "user")).toMatchObject({ snapshot: { owner: "olive", notes: 0 } });
  });

  it("link.onUpdate: if the event can't be written, neither the state nor the link version is", async () => {
    const stub = await spawnProbe("j-atomic-link");
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO active_links (target_type, target_id, link_name, version, created_at) VALUES ('NOT_AN_ACTOR', 'r1', 'room', 0, 0)",
      );
    });
    // Called in-process: a rejected RPC would surface as an uncaught exception in the DO.
    const s = await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.__receiveLinkUpdate("NOT_AN_ACTOR", "r1", { big: 1n }, "member", 5)).rejects.toThrow(
        /BigInt/,
      );
      return {
        journal: readJournal(state.storage.sql),
        snapshot: SnapshotRow.parse(state.storage.sql.exec("SELECT state, checksum, version FROM snapshots").one()),
        linkVersion: z
          .object({ version: z.number() })
          .parse(state.storage.sql.exec("SELECT version FROM active_links").one()).version,
      };
    });
    expect(s.linkVersion).toBe(0);
    expect(probeState(s.snapshot.state).linkViews).toEqual([]);
    expectSnapshotMatchesJournal(s);
  });
});

describe("journal: configuration", () => {
  it("journal: false writes no events", async () => {
    const stub = env.JOURNAL_OFF.get(env.JOURNAL_OFF.idFromName(unique("j-off")));
    await stub.send("alice", "user", { type: "INC" });
    await stub.send("alice", "user", { type: "INC" });
    const s = await storage(stub);
    expect(s.journal).toEqual({ events: [], checkpoints: [] });
    expect(JSON.parse(s.snapshot.state)).toEqual({ count: 2 });
  });

  it("checkpoints every N events and prunes to `keep`, never past the newest needed checkpoint", async () => {
    const stub = env.JOURNAL_KEEP.get(env.JOURNAL_KEEP.idFromName(unique("j-keep")));
    for (let i = 0; i < 6; i++) await stub.send("alice", "user", { type: "INC" });
    // seq 1 = init, 2..7 = INC. Checkpoints at 2, 4, 6. keep 3 → base = newest checkpoint <= 7 - 3 = 4.
    const s = await storage(stub);
    expect(s.journal.events.map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(s.journal.checkpoints.map((c) => [c.seq, JSON.parse(c.state)])).toEqual([
      [4, { count: 3 }],
      [6, { count: 5 }],
    ]);
    expect(s.journal.checkpoints[0]?.checksum).toBe(xxh64('{"count":3}'));
    expectSnapshotMatchesJournal(s);
  });
});

describe("checksums", () => {
  it("getSnapshot's view checksum is xxh64 of the view JSON", async () => {
    const stub = await spawnProbe("j-view");
    const { snapshot, checksum } = await stub.getSnapshot("alice", "user");
    expect(checksum).toBe(xxh64(JSON.stringify(snapshot)));
  });
});
