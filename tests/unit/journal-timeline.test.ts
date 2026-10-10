/**
 * One history (ADR-017 §5): Studio's timeline is read from the journal. Entries are journal events
 * (id = seq), their cause in the Studio cause shape, and their after-state taken from a checkpoint
 * or replayed from the newest checkpoint before it (checksum-verified). An after-state that cannot
 * be rebuilt (an older code version, a diverging replay) is null, never a wrong state.
 */
import { simulate } from "@actor-kit/test";
import {
  checksumState,
  defineActor,
  type JournalEvent,
  message,
  readStudioTimeline,
  timelineCause,
  timer,
} from "@actor-kit/worker/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { migratedSql, writeJournal } from "./helpers/journal-sql";
import type { NodeSql } from "./helpers/node-sql";

type S = { n: number };

const Tally = defineActor("tally", {
  input: z.object({}),
  init: (): S => ({ n: 0 }),
  roles: { any: () => true },
  messages: {
    ADD: message(z.object({ by: z.number() }), (s: S, { by }) => ({ n: s.n + by })),
    LATER: message(z.object({}), (s: S, _p, ctx) => {
      ctx.schedule("tick", { in: 10, key: "t" });
      return s;
    }),
  },
  timers: { tick: timer(z.object({}).optional(), (s: S) => ({ n: s.n * 10 })) },
  views: {},
  journal: { checkpointEvery: 4 },
});

const TallyDef = { ...Tally.def, messages: { any: Tally.def.messages } };
const source = { def: TallyDef, sourceType: (link: string) => link.toUpperCase() };

let sql: NodeSql | undefined;
afterEach(() => sql?.close());

/** A tally journal with `adds` ADD messages (by 1, 2, 3...), written to SQLite. */
async function tally(adds: number) {
  const sim = simulate({ contracts: [Tally], now: 100 });
  const actor = await sim.spawn(Tally, "t1", {});
  for (let i = 1; i <= adds; i++) actor.send("u", { type: "ADD", by: i });
  sql = migratedSql();
  writeJournal(sql, actor.journal);
  return { db: sql, actor, journal: actor.journal };
}

const states = (entries: Array<{ stateSnapshot: string | null }>) =>
  entries.map((e) => (e.stateSnapshot === null ? null : JSON.parse(e.stateSnapshot)));

function event(overrides: Partial<JournalEvent>): JournalEvent {
  return {
    seq: 1,
    causeType: "message",
    name: null,
    payload: null,
    caller: null,
    callerType: null,
    role: null,
    facts: {},
    codeVersion: 1,
    stateChecksum: "c",
    createdAt: 1,
    ...overrides,
  };
}

describe("timelineCause: journal events in the Studio cause shapes", () => {
  const type = (link: string) => `T_${link}`;

  it.each([
    ["init", event({ causeType: "init", payload: { owner: "x" } }), {}],
    [
      "migrate",
      event({ causeType: "migrate", payload: { fromVersion: 1, toVersion: 2 } }),
      { fromVersion: 1, toVersion: 2 },
    ],
    ["restore", event({ causeType: "restore", payload: { toSeq: 3 } }), { toSeq: 3 }],
    [
      "message",
      event({ name: "ADD", payload: { by: 2 }, caller: "u", callerType: "user", role: "any" }),
      { messageType: "ADD", caller: "u", callerType: "user", role: "any", payload: { by: 2 } },
    ],
    [
      "connect",
      event({
        causeType: "lifecycle.connect",
        payload: { callerConnections: 1 },
        caller: "u",
        callerType: "user",
        role: "m",
      }),
      { caller: "u", callerType: "user", role: "m" },
    ],
    [
      "disconnect without a role",
      event({ causeType: "lifecycle.disconnect", payload: {}, caller: "u", callerType: "service", role: null }),
      { caller: "u", callerType: "service", role: "unknown" },
    ],
    [
      "service.onDone",
      event({
        causeType: "service.onDone",
        name: "PAY",
        payload: { input: { a: 1 }, result: { ok: true }, effectId: "2:0" },
      }),
      { service: "PAY", input: { a: 1 }, result: { ok: true } },
    ],
    [
      "service.onError",
      event({
        causeType: "service.onError",
        name: "PAY",
        payload: { input: 1, error: { message: "boom" }, effectId: "2:0" },
      }),
      { service: "PAY", input: 1, error: "boom" },
    ],
    [
      "link.onUpdate",
      event({ causeType: "link.onUpdate", name: "room", payload: { sourceId: "r1", view: { role: "x", n: 1 } } }),
      { sourceType: "T_room", sourceId: "r1", viewData: { role: "x", n: 1 } },
    ],
    [
      "link.onError",
      event({
        causeType: "link.onError",
        name: "room",
        payload: { targetId: "r2", error: { message: "gone", code: "unreachable" } },
      }),
      { sourceType: "T_room", sourceId: "r2", error: "gone" },
    ],
    [
      "timer",
      event({
        causeType: "timer",
        name: "tick",
        payload: { id: "2:0", key: "t", payload: null, fireAt: 9, lateBy: 1 },
      }),
      { name: "tick", key: "t", payload: null, fireAt: 9, lateBy: 1 },
    ],
  ])("%s", (_name, journalEvent, expected) => {
    expect(timelineCause(journalEvent, type)).toStrictEqual(expected);
  });

  it("a message, service or link event without its name is reported as unknown", () => {
    expect(timelineCause(event({ name: null, caller: "u", callerType: "user", role: "r" }), type)).toMatchObject({
      messageType: "unknown",
    });
    expect(
      timelineCause(event({ causeType: "link.onUpdate", payload: { sourceId: "r1", view: 1 } }), type),
    ).toMatchObject({
      sourceType: "unknown",
    });
  });

  it("a message without a caller is reported as unknown (never throws)", () => {
    expect(timelineCause(event({ name: "ADD", payload: {} }), type)).toStrictEqual({
      messageType: "ADD",
      caller: "unknown",
      callerType: "user",
      role: "unknown",
      payload: {},
    });
  });
});

describe("readStudioTimeline", () => {
  it("lists journal events newest first, id = seq, with checksum, time and after-state", async () => {
    const { db, journal } = await tally(3);
    const page = await readStudioTimeline(db, source, { limit: 50 });
    expect(page.hasMore).toBe(false);
    expect(page.entries.map((e) => [e.id, e.seq, e.causeType])).toEqual([
      [4, 4, "message"],
      [3, 3, "message"],
      [2, 2, "message"],
      [1, 1, "init"],
    ]);
    expect(states(page.entries)).toEqual([{ n: 6 }, { n: 3 }, { n: 1 }, { n: 0 }]);
    expect(page.entries.map((e) => e.checksum)).toEqual([...journal.events].reverse().map((e) => e.stateChecksum));
    expect(page.entries[0]).toMatchObject({
      createdAt: 100,
      causeData: JSON.stringify({
        messageType: "ADD",
        caller: "u",
        callerType: "user",
        role: "any",
        payload: { by: 3 },
      }),
    });
  });

  it("pages with an exclusive `before` cursor and reports hasMore", async () => {
    const { db } = await tally(5);
    const first = await readStudioTimeline(db, source, { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual([6, 5]);
    expect(first.hasMore).toBe(true);
    const second = await readStudioTimeline(db, source, { limit: 2, before: 5 });
    expect(second.entries.map((e) => e.id)).toEqual([4, 3]);
    expect(states(second.entries)).toEqual([{ n: 6 }, { n: 3 }]);
    const last = await readStudioTimeline(db, source, { limit: 2, before: 3 });
    expect(last.entries.map((e) => e.id)).toEqual([2, 1]);
    expect(last.hasMore).toBe(false);
    expect(await readStudioTimeline(db, source, { limit: 2, before: 1 })).toEqual({ entries: [], hasMore: false });
  });

  it("an empty journal is an empty timeline", async () => {
    sql = migratedSql();
    expect(await readStudioTimeline(sql, source, { limit: 5 })).toEqual({ entries: [], hasMore: false });
  });

  it("after-states replay from the newest checkpoint at or before the page", async () => {
    const { db } = await tally(9); // seqs 1..10, checkpoints at 4 and 8
    // Only checkpoints can start the fold: drop the events before the page (as pruning would).
    db.exec("DELETE FROM events WHERE seq <= 4");
    const page = await readStudioTimeline(db, source, { limit: 3, before: 9 });
    expect(page.entries.map((e) => e.id)).toEqual([8, 7, 6]);
    expect(states(page.entries)).toEqual([{ n: 28 }, { n: 21 }, { n: 15 }]);
  });

  it("a pruned journal with no checkpoint before the page has no after-states until the next checkpoint", async () => {
    const { db } = await tally(9);
    db.exec("DELETE FROM events WHERE seq <= 2");
    db.exec("DELETE FROM journal_checkpoints WHERE seq = 4");
    const page = await readStudioTimeline(db, source, { limit: 10 });
    expect(page.entries.map((e) => e.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(states(page.entries)).toEqual([{ n: 45 }, { n: 36 }, { n: 28 }, null, null, null, null, null]);
  });

  it("an event written by another code version is not replayed (null unless checkpointed)", async () => {
    const { db } = await tally(5);
    db.exec("UPDATE events SET code_version = 0 WHERE seq <= 5");
    const page = await readStudioTimeline(db, source, { limit: 10 });
    // seq 4 is a checkpoint: its state is known; 5 is from the old version; 6 replays from... nothing.
    expect(states(page.entries)).toEqual([null, null, { n: 6 }, null, null, null]);
  });

  it("a replay that diverges from the recorded checksum shows null, then recovers at a checkpoint", async () => {
    const { db } = await tally(9);
    db.exec("UPDATE events SET state_checksum = 'wrong' WHERE seq = 2");
    const page = await readStudioTimeline(db, source, { limit: 10 });
    expect(states(page.entries)).toEqual([
      { n: 45 },
      { n: 36 },
      { n: 28 },
      { n: 21 },
      { n: 15 },
      { n: 10 },
      { n: 6 },
      null,
      null,
      { n: 0 },
    ]);
  });

  it("a checkpoint whose checksum does not match is not trusted", async () => {
    const { db } = await tally(3);
    db.exec("UPDATE journal_checkpoints SET checksum = 'wrong' WHERE seq = 4");
    const page = await readStudioTimeline(db, source, { limit: 1 });
    expect(states(page.entries)).toEqual([null]);
  });

  it("a restore event's after-state is the state it restored, also when the target is before the page", async () => {
    const { db, actor } = await tally(5); // seqs 1..6, state n=15
    const target = { n: 3 }; // after seq 3
    db.exec(
      "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at) VALUES (7, 'restore', NULL, '{\"toSeq\":3}', NULL, NULL, NULL, '{}', 1, ?, 200)",
      checksumState(TallyDef, target),
    );
    expect(actor.state).toEqual({ n: 15 });
    const all = await readStudioTimeline(db, source, { limit: 10 });
    expect(all.entries[0]).toMatchObject({ id: 7, causeType: "restore", causeData: '{"toSeq":3}' });
    expect(states(all.entries)[0]).toEqual(target);
    const one = await readStudioTimeline(db, source, { limit: 1 });
    expect(states(one.entries)).toEqual([target]);
  });

  it("a restore to a seq whose state cannot be rebuilt is null", async () => {
    const { db } = await tally(5);
    db.exec("DELETE FROM events WHERE seq <= 2");
    db.exec("DELETE FROM journal_checkpoints");
    db.exec(
      "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at) VALUES (7, 'restore', NULL, '{\"toSeq\":3}', NULL, NULL, NULL, '{}', 1, 'x', 200)",
    );
    expect(states((await readStudioTimeline(db, source, { limit: 1 })).entries)).toEqual([null]);
  });

  it("a page whose oldest entry is a checkpoint takes its state from it", async () => {
    const { db } = await tally(3); // seqs 1..4, checkpoint at 4
    db.exec("DELETE FROM events WHERE seq < 4");
    expect(states((await readStudioTimeline(db, source, { limit: 1 })).entries)).toEqual([{ n: 6 }]);
  });

  it("an event whose handler is gone has no state, until the next checkpoint", async () => {
    const { db } = await tally(5); // seqs 1..6, checkpoint at 4
    const { ADD: _gone, ...rest } = Tally.def.messages;
    const def = { ...Tally.def, messages: { any: rest } };
    const page = await readStudioTimeline(db, { def, sourceType: (l) => l }, { limit: 10 });
    expect(states(page.entries)).toEqual([null, null, { n: 6 }, null, null, { n: 0 }]);
  });

  it("replays with the actor's env", async () => {
    const Bonus = defineActor("bonus", {
      input: z.object({}),
      init: (): S => ({ n: 0 }),
      roles: { any: () => true },
      messages: {
        ADD: message(z.object({}), (s: S, _p, ctx: { env: { BONUS: number } }) => ({ n: s.n + ctx.env.BONUS })),
      },
      views: {},
    });
    const env = { BONUS: 5 };
    const sim = simulate({ contracts: [Bonus], env });
    const actor = await sim.spawn(Bonus, "b1", {});
    actor.send("u", { type: "ADD" });
    sql = migratedSql();
    writeJournal(sql, actor.journal);
    const def = { ...Bonus.def, messages: { any: Bonus.def.messages } };
    const page = await readStudioTimeline(sql, { def, sourceType: (l) => l, env }, { limit: 1 });
    expect(states(page.entries)).toEqual([{ n: 5 }]);
    const without = await readStudioTimeline(sql, { def, sourceType: (l) => l, env: { BONUS: 1 } }, { limit: 1 });
    expect(states(without.entries)).toEqual([null]);
  });

  it.each([
    ["a malformed payload", "{}"],
    ["a seq the journal never reached", '{"toSeq":99}'],
    ["its own seq", '{"toSeq":4}'],
  ])("a restore event with %s has no state (the page still loads)", async (_name, payload) => {
    const { db } = await tally(2);
    db.exec(
      "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at) VALUES (4, 'restore', NULL, ?, NULL, NULL, NULL, '{}', 1, 'x', 200)",
      payload,
    );
    const page = await readStudioTimeline(db, source, { limit: 10 });
    expect(states(page.entries)).toEqual([null, { n: 3 }, { n: 1 }, { n: 0 }]);
  });

  it("timers fired in the window replay with their schedules (checkpointed timers included)", async () => {
    const sim = simulate({ contracts: [Tally], now: 0 });
    const actor = await sim.spawn(Tally, "t2", {});
    actor.send("u", { type: "ADD", by: 2 });
    actor.send("u", { type: "LATER" });
    actor.send("u", { type: "ADD", by: 1 }); // seq 4: checkpoint, timer pending
    sim.advance(20); // seq 5: the timer fires
    sql = migratedSql();
    writeJournal(sql, actor.journal);
    const page = await readStudioTimeline(sql, source, { limit: 1 });
    expect(page.entries[0]).toMatchObject({ causeType: "timer" });
    expect(states(page.entries)).toEqual([{ n: 30 }]);
  });
});
