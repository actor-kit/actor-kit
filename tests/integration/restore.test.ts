/**
 * Restore (ADR-015 D3) on a real Durable Object: __restore({ toSeq }) appends a `restore` event
 * (history is kept), puts the state back, rebuilds the timers pending then with their original
 * deadlines, never re-runs an effect, redelivers results recorded after toSeq as new events,
 * and fails effects that only the undone transitions declared. On wake, a snapshot that lags
 * the journal is rebuilt from it.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { type Journal, readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Ledger, LedgerContract, payCalls } from "./src/restore-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

type Namespace = "LEDGER" | "LEDGER_NO_JOURNAL" | "LEDGER_NO_STUDIO";

async function spawn(prefix: string, ns: Namespace = "LEDGER") {
  const name = unique(prefix);
  const stub = env[ns].get(env[ns].idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

type Stub = Awaited<ReturnType<typeof spawn>>;

const LedgerStateSchema = z.object({ total: z.number(), paid: z.array(z.string()), rings: z.array(z.string()) });

async function look(stub: Stub) {
  return runInDurableObject(stub, async (_i, state) => {
    const sql = state.storage.sql;
    return {
      journal: readJournal(sql),
      state: LedgerStateSchema.parse(JSON.parse(String(sql.exec("SELECT state FROM snapshots").one()["state"]))),
      timers: sql.exec("SELECT id, key, fire_at FROM timers ORDER BY fire_at").toArray(),
      executions: sql.exec("SELECT id, service, status, last_error FROM executions ORDER BY seq, idx").toArray(),
      alarm: await state.storage.getAlarm(),
    };
  });
}

const lastSeq = (journal: Journal) => journal.events.at(-1)?.seq ?? 0;

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function rpcError(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("__restore: state and history", () => {
  it("puts the state back to toSeq and appends a restore event; nothing is deleted", async () => {
    const stub = await spawn("state");
    await stub.send("u", "user", { type: "ADD", n: 1 }); // seq 2
    await stub.send("u", "user", { type: "ADD", n: 10 }); // seq 3
    await stub.send("u", "user", { type: "ADD", n: 100 }); // seq 4
    expect(await stub.__restore({ toSeq: 3 })).toEqual({ ok: true });
    const after = await look(stub);
    expect(after.state.total).toBe(11);
    expect(after.journal.events.map((e) => e.causeType)).toEqual(["init", "message", "message", "message", "restore"]);
    expect(after.journal.events.at(-1)).toMatchObject({ seq: 5, payload: { toSeq: 3 }, caller: null });
    await stub.send("u", "user", { type: "ADD", n: 5 });
    expect((await look(stub)).state.total).toBe(16);
  });

  it("can undo a restore with another restore", async () => {
    const stub = await spawn("undo");
    await stub.send("u", "user", { type: "ADD", n: 1 }); // 2
    await stub.send("u", "user", { type: "ADD", n: 2 }); // 3
    await stub.__restore({ toSeq: 2 }); // 4
    expect((await look(stub)).state.total).toBe(1);
    await stub.__restore({ toSeq: 3 }); // 5
    expect((await look(stub)).state.total).toBe(3);
  });

  it("the journal with restore events replays to the same state", async () => {
    const stub = await spawn("replay");
    for (const v of [1, 2, 3, 4, 5]) await stub.send("u", "user", { type: "ADD", n: v });
    await stub.__restore({ toSeq: 3 });
    await stub.send("u", "user", { type: "ADD", n: 7 });
    const { journal, state } = await look(stub);
    expect((await replayJournal(LedgerContract, journal)).state).toEqual(state);
  });

  it("refuses a seq outside the journal, leaving everything as it was", async () => {
    const stub = await spawn("bad-seq");
    await stub.send("u", "user", { type: "ADD", n: 1 });
    expect(await stub.__restore({ toSeq: 9 })).toEqual({
      ok: false,
      error: "Cannot restore to seq 9: the journal runs from 1 to 2",
    });
    expect((await look(stub)).journal.events).toHaveLength(2);
  });

  it("broadcasts the restored view to connected clients", async () => {
    const stub = await spawn("broadcast");
    const res = await stub.fetch("http://localhost/ws", {
      headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "u", "X-Actor-Kit-Caller-Type": "user" },
    });
    const ws = res.webSocket;
    if (ws === null) throw new Error("no socket");
    const frames: string[] = [];
    ws.addEventListener("message", (e) => frames.push(String(e.data)));
    ws.accept();
    await stub.send("u", "user", { type: "ADD", n: 4 });
    await stub.__restore({ toSeq: 1 });
    await waitFor(
      async () => frames,
      (f) => f.some((x) => x.includes('"total":0')) && f.some((x) => x.includes('"total":4')),
    );
    expect(frames.at(-1)).toContain('"total":0');
    ws.close(1000, "done");
  });
});

describe("__restore: timers", () => {
  it("rebuilds the timers pending at toSeq with their original deadlines; overdue ones fire on the alarm", async () => {
    const stub = await spawn("timers");
    await stub.send("u", "user", { type: "LATER", inMs: 60_000, key: "a" }); // seq 2
    const scheduled = await look(stub);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("UPDATE timers SET fire_at = fire_at - 60000");
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub); // seq 3: a fires
    await stub.send("u", "user", { type: "LATER", inMs: 60_000, key: "b" }); // seq 4
    expect((await look(stub)).state.rings).toEqual(["a"]);

    expect(await stub.__restore({ toSeq: 2 })).toEqual({ ok: true });
    const restored = await look(stub);
    // The deadline the journal recorded (the test moved the table's copy earlier only to fire it).
    const fireAt = Number(scheduled.timers[0]?.["fire_at"]);
    expect(restored.state.rings).toEqual([]);
    expect(restored.timers).toEqual([{ id: "2:0", key: "a", fire_at: fireAt }]);
    expect(restored.alarm).toBe(fireAt);

    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec("UPDATE timers SET fire_at = fire_at - 60000");
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    expect((await look(stub)).state.rings).toEqual(["a"]);
  });
});

describe("__restore: effects", () => {
  it("never calls a service again: a result recorded after toSeq is redelivered as a new event", async () => {
    const stub = await spawn("redeliver");
    await stub.send("u", "user", { type: "BUY", item: "hat" }); // seq 2, effect 2:0
    await waitFor(
      () => look(stub),
      (v) => v.state.paid.length === 1,
    ); // seq 3 = onDone
    await stub.send("u", "user", { type: "ADD", n: 9 }); // seq 4
    const calls = payCalls.get("hat");

    expect(await stub.__restore({ toSeq: 2 })).toEqual({ ok: true });
    const { journal, state } = await look(stub);
    expect(payCalls.get("hat")).toBe(calls);
    expect(state).toEqual({ total: 0, paid: ["r-hat"], rings: [] });
    expect(journal.events.slice(-2).map((e) => [e.causeType, e.payload])).toEqual([
      ["restore", { toSeq: 2 }],
      ["service.onDone", { input: { item: "hat" }, result: { receipt: "r-hat" }, effectId: "2:0" }],
    ]);
    expect((await replayJournal(LedgerContract, journal)).state).toEqual(state);
  });

  it("does not redeliver results of effects that only the undone transitions declared", async () => {
    const stub = await spawn("undone-result");
    await stub.send("u", "user", { type: "ADD", n: 1 }); // seq 2
    await stub.send("u", "user", { type: "BUY", item: "cap" }); // seq 3
    await waitFor(
      () => look(stub),
      (v) => v.state.paid.length === 1,
    ); // seq 4
    await stub.__restore({ toSeq: 2 });
    const { state, journal } = await look(stub);
    expect(state.paid).toEqual([]);
    expect(journal.events.at(-1)?.causeType).toBe("restore");
  });

  it("fails effects still pending that the undone transitions declared, saying why", async () => {
    const stub = await spawn("cancel");
    await stub.send("u", "user", { type: "ADD", n: 1 }); // seq 2
    await stub.send("u", "user", { type: "SLOW" }); // seq 3, waits a minute to retry
    await waitFor(
      () => look(stub),
      (v) => v.executions[0]?.["status"] === "retrying",
    );
    await stub.__restore({ toSeq: 2 });
    const { executions } = await look(stub);
    expect(executions).toEqual([
      { id: "3:0", service: "STUCK", status: "failed", last_error: "cancelled: the actor was restored to seq 2" },
    ]);
  });

  it("keeps effects declared at or before toSeq", async () => {
    const stub = await spawn("keep");
    await stub.send("u", "user", { type: "SLOW" }); // seq 2
    await waitFor(
      () => look(stub),
      (v) => v.executions[0]?.["status"] === "retrying",
    );
    await stub.send("u", "user", { type: "ADD", n: 1 }); // seq 3
    await stub.__restore({ toSeq: 2 });
    expect((await look(stub)).executions[0]?.["status"]).toBe("retrying");
  });
});

describe("__restore: who may", () => {
  it("is refused when Studio is disabled", async () => {
    const stub = await spawn("no-studio", "LEDGER_NO_STUDIO");
    expect(await rpcError(() => stub.__restore({ toSeq: 1 }))).toMatch(/Studio is not enabled/);
  });

  it("needs the journal", async () => {
    const stub = await spawn("no-journal", "LEDGER_NO_JOURNAL");
    expect(await stub.__restore({ toSeq: 1 })).toEqual({
      ok: false,
      error: "Restore needs the journal (journal: false)",
    });
  });
});

describe("Studio timeline", () => {
  it("timeline entries carry the journal seq they recorded", async () => {
    const stub = await spawn("timeline-seq");
    await stub.send("u", "user", { type: "ADD", n: 1 });
    const { entries } = await stub.__getTimeline();
    expect(entries.map((e) => [e.causeType, e.seq])).toEqual([
      ["message", 2],
      ["init", 1],
    ]);
  });
});

describe("replay on wake", () => {
  it("a snapshot that lags the journal is rebuilt from it when the actor wakes", async () => {
    const stub = await spawn("wake");
    for (const v of [1, 2, 3, 4, 5]) await stub.send("u", "user", { type: "ADD", n: v });
    const before = await look(stub);
    const total = await runInDurableObject(stub, async (_i, state) => {
      // As if the last commits' snapshot writes were lost: an older state, an older last_seq.
      state.storage.sql.exec(
        "UPDATE snapshots SET state = ?, last_seq = 2",
        JSON.stringify({ total: 1, paid: [], rings: [] }),
      );
      const fresh = new Ledger(state, env);
      const snapshot = await fresh.getSnapshot("u", "user");
      return snapshot.snapshot;
    });
    expect(total).toEqual({ total: 15 });
    const after = await look(stub);
    expect(after.state.total).toBe(15);
    expect(after.journal.events).toHaveLength(before.journal.events.length);
    const lastSeqRow = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec("SELECT last_seq FROM snapshots").one(),
    );
    expect(lastSeqRow["last_seq"]).toBe(lastSeq(before.journal));
  });
});
