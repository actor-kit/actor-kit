/**
 * Durable timers (ADR-015 D2): ctx.schedule persists a row keyed by effect id with an absolute
 * deadline, one DO alarm points at the earliest deadline, alarm() fires every due timer in
 * (fire_at, id) order in its own transaction and journal event, late timers all fire with
 * ctx.lateBy, and timers survive eviction and work without the journal.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Quiz, QuizContract } from "./src/timers-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

type Namespace = "QUIZ" | "QUIZ_NO_JOURNAL" | "QUIZ_NO_STUDIO" | "QUIZ_LIFECYCLE";

async function spawn(prefix: string, ns: Namespace = "QUIZ") {
  const name = unique(prefix);
  const stub = env[ns].get(env[ns].idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

type Stub = Awaited<ReturnType<typeof spawn>>;

const TimerRow = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  payload: z.string(),
  fire_at: z.number(),
});
const Fired = z.object({ name: z.string(), key: z.string(), lateBy: z.number(), at: z.number(), payload: z.unknown() });
const QuizStateSchema = z.object({ round: z.number(), phase: z.string(), fired: z.array(Fired), pinged: z.number() });

async function look(stub: Stub) {
  return runInDurableObject(stub, async (_i, state) => ({
    timers: state.storage.sql
      .exec("SELECT id, name, key, payload, fire_at FROM timers ORDER BY fire_at, seq, idx")
      .toArray()
      .map((row) => TimerRow.parse(row)),
    alarm: await state.storage.getAlarm(),
    state: QuizStateSchema.parse(
      JSON.parse(String(state.storage.sql.exec("SELECT state FROM snapshots").one()["state"])),
    ),
  }));
}

/** Pull every pending deadline back by `ms` and point the alarm at now, so alarm() finds them due. */
async function makeDue(stub: Stub, ms = 3_600_000) {
  await runInDurableObject(stub, async (_i, state) => {
    state.storage.sql.exec("UPDATE timers SET fire_at = fire_at - ?", ms);
    await state.storage.setAlarm(Date.now());
  });
}

async function rpcError(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ctx.schedule", () => {
  it("persists a row keyed by effect id with fire_at = now + in, and points the alarm at it", async () => {
    const stub = await spawn("schedule");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    const { timers, alarm } = await look(stub);
    const journal = await runInDurableObject(stub, (_i, state) => readJournal(state.storage.sql));
    const start = journal.events.at(-1);
    expect(timers).toEqual([
      {
        id: `${start?.seq}:0`,
        name: "roundEnd",
        key: "round-1",
        payload: JSON.stringify({ round: 1, secret: "answer-42" }),
        fire_at: (start?.facts.now ?? 0) + 60_000,
      },
    ]);
    expect(alarm).toBe(timers[0]?.fire_at);
  });

  it("refuses a payload the timer's schema rejects: the message fails and nothing is written", async () => {
    const stub = await spawn("bad-payload");
    expect(await rpcError(() => stub.send("u", "user", { type: "BAD" }))).toMatch(/Timer "roundEnd": invalid payload/);
    expect((await look(stub)).timers).toEqual([]);
  });

  it("cancel removes the timer and clears the alarm", async () => {
    const stub = await spawn("cancel");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    await stub.send("u", "user", { type: "SKIP" });
    const { timers, alarm } = await look(stub);
    expect(timers).toEqual([]);
    expect(alarm).toBeNull();
  });

  it("scheduling an existing key replaces it (debounce)", async () => {
    const stub = await spawn("debounce");
    await stub.send("u", "user", { type: "DEBOUNCE", inMs: 60_000 });
    await stub.send("u", "user", { type: "DEBOUNCE", inMs: 120_000 });
    const { timers } = await look(stub);
    expect(timers.map((t) => [t.key, JSON.parse(t.payload)])).toEqual([["debounced", { inMs: 120_000 }]]);
  });
});

describe("alarm()", () => {
  it("does nothing when it runs before any timer is due", async () => {
    const stub = await spawn("early");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    await runDurableObjectAlarm(stub);
    const { timers, state } = await look(stub);
    expect(timers).toHaveLength(1);
    expect(state.fired).toEqual([]);
  });

  it("fires a due timer in its own transition: state, journal event, row deleted, alarm cleared", async () => {
    const stub = await spawn("fire");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    const [timer] = (await look(stub)).timers;
    await makeDue(stub, 60_000);
    await runDurableObjectAlarm(stub);
    const { timers, alarm, state } = await look(stub);
    expect(timers).toEqual([]);
    expect(alarm).toBeNull();
    expect(state.phase).toBe("reveal");
    expect(state.fired).toEqual([
      expect.objectContaining({ name: "roundEnd", key: "round-1", payload: { round: 1, secret: "answer-42" } }),
    ]);
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    expect(journal.events.at(-1)).toMatchObject({
      causeType: "timer",
      name: "roundEnd",
      caller: null,
      role: null,
      payload: {
        id: timer?.id,
        key: "round-1",
        payload: { round: 1, secret: "answer-42" },
        fireAt: (timer?.fire_at ?? 0) - 60_000,
      },
    });
  });

  it("fires every late timer, in (fire_at, id) order, each with how late it was", async () => {
    const stub = await spawn("late");
    const base = Date.now() - 10_000;
    // Scheduled out of order; batch-1 and batch-2 share a deadline and fire by effect index.
    await stub.send("u", "user", { type: "BATCH", at: [base + 3000, base + 1000, base + 1000] });
    await runInDurableObject(stub, (_i, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(stub);
    const { state, timers } = await look(stub);
    expect(timers).toEqual([]);
    expect(state.fired.map((f) => f.key)).toEqual(["batch-1", "batch-2", "batch-0"]);
    for (const f of state.fired) expect(f.lateBy).toBe(f.at - (f.key === "batch-0" ? base + 3000 : base + 1000));
    // One alarm, one clock: every late timer sees the same ctx.now().
    expect(new Set(state.fired.map((f) => f.at)).size).toBe(1);
    expect(state.fired[0]?.lateBy).toBeGreaterThanOrEqual(9000);
  });

  it("a timer that reschedules itself with in: 0 fires once per alarm, not forever", async () => {
    const stub = await spawn("loop");
    await stub.send("u", "user", { type: "LOOP" });
    // Real alarms may fire meanwhile (in: 0); one fireDueTimers pass must fire exactly one timer.
    const { before, after, pending } = await runInDurableObject(stub, (instance, state) => {
      const count = () =>
        QuizStateSchema.parse(JSON.parse(String(state.storage.sql.exec("SELECT state FROM snapshots").one()["state"])))
          .fired.length;
      const before = count();
      instance.fireDueTimers(Date.now() + 1);
      const pending = state.storage.sql.exec("SELECT key FROM timers").toArray();
      return { before, after: count(), pending };
    });
    expect(after - before).toBe(1);
    expect(pending).toEqual([{ key: "again" }]);
  });

  it("timer handlers can run effects: ping executes a service whose onDone lands", async () => {
    const stub = await spawn("ping");
    await stub.send("u", "user", { type: "PING_LATER", inMs: 60_000 });
    await makeDue(stub, 60_000);
    await runDurableObjectAlarm(stub);
    const { state } = await waitFor(
      () => look(stub),
      (v) => v.state.pinged === 1,
    );
    expect(state.fired.map((f) => f.name)).toEqual(["ping"]);
  });

  it("fires on its own: a real alarm runs a short timer without being triggered", async () => {
    const stub = await spawn("real-alarm");
    await stub.send("u", "user", { type: "START", inMs: 30 });
    const { state } = await waitFor(
      () => look(stub),
      (v) => v.state.phase === "reveal",
    );
    expect(state.fired).toHaveLength(1);
  });

  it("shares the alarm with outbox retries: the alarm is the earlier deadline", async () => {
    const stub = await spawn("shared-alarm");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    const { timers } = await look(stub);
    const retryAt = (timers[0]?.fire_at ?? 0) - 30_000;
    const alarm = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO executions (id, seq, idx, service, payload, status, attempts, created_at, next_attempt_at) VALUES ('99:0', 99, 0, 'PING', '{}', 'retrying', 1, 0, ?)",
        retryAt,
      );
      instance.syncAlarm();
      return await state.storage.getAlarm();
    });
    expect(alarm).toBe(retryAt);
  });
});

describe("durability", () => {
  it("a timer survives eviction: a fresh instance's alarm() fires it", async () => {
    const stub = await spawn("evict");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    await makeDue(stub, 60_000);
    await runInDurableObject(stub, async (_i, state) => {
      const fresh = new Quiz(state, env);
      await fresh.alarm();
    });
    const { state, timers } = await look(stub);
    expect(state.phase).toBe("reveal");
    expect(timers).toEqual([]);
  });

  it("works with journal: false (the table is the truth)", async () => {
    const stub = await spawn("no-journal", "QUIZ_NO_JOURNAL");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    await makeDue(stub, 60_000);
    await runDurableObjectAlarm(stub);
    const { state } = await look(stub);
    expect(state.phase).toBe("reveal");
    const events = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql.exec("SELECT COUNT(*) AS n FROM events").one(),
    );
    expect(events["n"]).toBe(0);
  });

  it("the journal of a timer-driven actor replays to the same state", async () => {
    const stub = await spawn("replay");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    await stub.send("u", "user", { type: "DEBOUNCE", inMs: 1000 });
    await makeDue(stub, 60_000);
    await runDurableObjectAlarm(stub);
    const journal = await runInDurableObject(stub, (_i, s) => readJournal(s.storage.sql));
    const { state } = await replayJournal(QuizContract, journal);
    expect(state).toEqual((await look(stub)).state);
  });
});

describe("Studio", () => {
  it("__inspect lists pending timers with redacted payloads", async () => {
    const stub = await spawn("inspect");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    const inspected = await stub.__inspect();
    expect(inspected.timers).toEqual([
      {
        id: expect.stringMatching(/^\d+:0$/),
        name: "roundEnd",
        key: "round-1",
        payload: JSON.stringify({ round: 1, secret: "[redacted]" }),
        fireAt: expect.any(Number),
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("__fireTimer fires a pending timer now, by key", async () => {
    const stub = await spawn("fire-now");
    await stub.send("u", "user", { type: "START", inMs: 60_000 });
    expect(await stub.__fireTimer({ key: "round-1" })).toEqual({ ok: true });
    const { state, timers, alarm } = await look(stub);
    expect(state.phase).toBe("reveal");
    expect(state.fired[0]?.lateBy).toBe(0);
    expect(timers).toEqual([]);
    expect(alarm).toBeNull();
    expect(await stub.__fireTimer({ key: "round-1" })).toEqual({
      ok: false,
      error: 'No pending timer with key "round-1"',
    });
  });

  it("__fireTimer is refused when Studio is disabled", async () => {
    const stub = await spawn("fire-off", "QUIZ_NO_STUDIO");
    expect(await rpcError(() => stub.__fireTimer({ key: "round-1" }))).toMatch(/Studio is not enabled/);
  });
});

describe("lifecycle handlers", () => {
  it("a connect that only schedules, and a disconnect that only cancels, are committed", async () => {
    const stub = await spawn("lifecycle", "QUIZ_LIFECYCLE");
    const response = await stub.fetch("http://localhost/", {
      headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": "u1", "X-Actor-Kit-Caller-Type": "user" },
    });
    const ws = response.webSocket;
    if (ws === null) throw new Error("expected a WebSocket");
    ws.accept();
    expect((await look(stub)).timers.map((t) => t.key)).toEqual(["hello-u1"]);
    expect((await look(stub)).alarm).not.toBeNull();

    ws.close(1000, "bye");
    await expect.poll(async () => (await look(stub)).timers).toEqual([]);
  });
});
