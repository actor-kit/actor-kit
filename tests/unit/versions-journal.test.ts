/**
 * The version chain and the journal (ADR-015 D5): replay starts at the last version bump (the
 * migrate event's checkpoint), refuses events written by a version with no path to the current
 * one, rebuild-by-replay folds the whole journal under the new handlers with upcast payloads, and
 * restore never goes back past a bump.
 */
import { xxh64 } from "@actor-kit/core";
import {
  ACTOR_KIT_MIGRATIONS,
  appendJournalEvent,
  checksumState,
  foldJournal,
  type JournalEvent,
  JournalVersionError,
  planRestore,
  readJournal,
  rebuildFromJournal,
  resolveJournalConfig,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { createNodeSql } from "./helpers/node-sql";

type S = { names: string[] };

/** Version 3 of an actor: JOIN payloads gained `avatar` in version 2. */
const v3 = {
  version: 3,
  knownVersions: [1, 2, 3],
  init: (): S => ({ names: [] }),
  messages: {
    r: {
      JOIN: {
        handler: (s: S, p: { name: string; avatar: string | null }) => ({
          names: [...s.names, `${p.name}:${p.avatar}`],
        }),
      },
    },
  },
  upcast: (message: string, payload: unknown, from: number) =>
    message === "JOIN" && from < 2 && typeof payload === "object" && payload !== null
      ? { ...payload, avatar: null }
      : payload,
};

const sum = (s: S) => checksumState({}, s);

function ev(seq: number, causeType: JournalEvent["causeType"], over: Partial<JournalEvent> = {}): JournalEvent {
  return {
    seq,
    causeType,
    name: null,
    payload: {},
    caller: null,
    callerType: null,
    role: null,
    facts: {},
    codeVersion: 3,
    stateChecksum: "",
    createdAt: 0,
    ...over,
  };
}

const join = (seq: number, name: string, after: S, codeVersion = 3, payload: object = { name, avatar: "x" }) =>
  ev(seq, "message", {
    name: "JOIN",
    role: "r",
    caller: "u",
    callerType: "user",
    payload,
    codeVersion,
    stateChecksum: sum(after),
  });

/** Written by version 1 (JOIN had no avatar), migrated to 3 at seq 4, then two version-3 JOINs. */
function spanningJournal() {
  const atBump: S = { names: ["a:null", "b:null"] };
  const events = [
    ev(1, "init", { codeVersion: 1, stateChecksum: sum({ names: [] }) }),
    join(2, "a", { names: ["a"] }, 1, { name: "a" }),
    join(3, "b", { names: ["a", "b"] }, 1, { name: "b" }),
    ev(4, "migrate", { payload: { fromVersion: 1, toVersion: 3 }, stateChecksum: sum(atBump) }),
    join(5, "c", { names: [...atBump.names, "c:x"] }),
    join(6, "d", { names: [...atBump.names, "c:x", "d:x"] }),
  ];
  const state = JSON.stringify(atBump);
  return { events, checkpoints: [{ seq: 4, version: 3, state, checksum: xxh64(state), timers: "[]" }] };
}

describe("foldJournal across a version bump", () => {
  it("starts from the last bump's checkpoint; older events are history it does not replay", async () => {
    const result = await foldJournal(v3, spanningJournal());
    expect(result).toEqual({ state: { names: ["a:null", "b:null", "c:x", "d:x"] }, replayed: 2 });
  });

  it("needs the checkpoint written at the bump", async () => {
    const journal = { ...spanningJournal(), checkpoints: [] };
    await expect(foldJournal(v3, journal)).rejects.toThrow("Journal replay: no checkpoint at the version bump (seq 4)");
  });

  it("refuses an event written by a version with no path to the current one", async () => {
    const journal = spanningJournal();
    const unknown = { ...journal, events: journal.events.map((e) => (e.seq === 2 ? { ...e, codeVersion: 7 } : e)) };
    const error = await foldJournal(v3, unknown).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalVersionError);
    expect(error).toMatchObject({
      message: "Journal replay: event 2 was written by version 7, which has no path to version 3",
      seq: 2,
      codeVersion: 7,
    });
    const ahead = { ...journal, events: journal.events.map((e) => (e.seq === 6 ? { ...e, codeVersion: 4 } : e)) };
    await expect(foldJournal(v3, ahead)).rejects.toThrow("written by version 4");
  });

  it("a def without a chain replays every event, as before", async () => {
    const { events } = spanningJournal();
    const plain = { init: v3.init, messages: v3.messages };
    const sameVersion = events.slice(0, 1).map((e) => ({ ...e, codeVersion: 1 }));
    expect(await foldJournal(plain, { events: sameVersion, checkpoints: [] })).toEqual({
      state: { names: [] },
      replayed: 1,
    });
  });
});

describe("rebuildFromJournal", () => {
  it("replays every event under the current handlers, upcasting older payloads, without checking checksums", async () => {
    const state = await rebuildFromJournal(v3, spanningJournal());
    expect(state).toEqual({ names: ["a:null", "b:null", "c:x", "d:x"] });
  });

  it("follows restore events back to their target", async () => {
    const journal = spanningJournal();
    const events = [...journal.events, ev(7, "restore", { payload: { toSeq: 5 } })];
    expect(await rebuildFromJournal(v3, { ...journal, events })).toEqual({ names: ["a:null", "b:null", "c:x"] });
  });

  it("needs the whole journal, from init", async () => {
    const journal = spanningJournal();
    await expect(rebuildFromJournal(v3, { ...journal, events: journal.events.slice(2) })).rejects.toThrow(
      "Rebuilding by replay needs the whole journal: it starts at seq 3",
    );
  });
});

describe("restore across a version bump", () => {
  it("refuses a seq written by an older version", async () => {
    await expect(planRestore(v3, spanningJournal(), 3)).rejects.toThrow(
      "Cannot restore to seq 3: it was written by version 1 (current: 3)",
    );
    expect((await planRestore(v3, spanningJournal(), 4)).state).toEqual({ names: ["a:null", "b:null"] });
  });
});

describe("appendJournalEvent at a version bump", () => {
  it("always checkpoints a migrate event", () => {
    const sql = createNodeSql();
    for (const m of ACTOR_KIT_MIGRATIONS) sql.exec(m.sql);
    const draft = {
      causeType: "migrate" as const,
      name: null,
      payload: {},
      caller: null,
      callerType: null,
      role: null,
      facts: {},
    };
    appendJournalEvent(sql, resolveJournalConfig({ checkpointEvery: 100 }), draft, {
      seq: 7,
      stateJson: "{}",
      checksum: "c",
      version: 3,
      now: 0,
    });
    expect(readJournal(sql).checkpoints.map((c) => c.seq)).toEqual([7]);
    sql.close();
  });
});
