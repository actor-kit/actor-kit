// biome-ignore-all lint/plugin: these tests read the clock in handlers on purpose, to check the determinism guard
import { JournalDivergenceError, NondeterminismError, replayJournal } from "@actor-kit/test";
import {
  checksumState,
  defineActor,
  type Journal,
  type JournalEvent,
  JournalNondeterminismError,
  message,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type Note = { id: string; text: string; at: number };
type State = { owner: string; notes: Note[] };

const Notes = defineActor("notes", {
  input: z.object({ owner: z.string() }),
  init: ({ owner }: { owner: string }): State => ({ owner, notes: [] }),
  roles: { owner: (s: State, caller: string) => caller === s.owner, guest: () => true },
  messages: {
    ADD: message(z.object({ text: z.string() }), (s: State, { text }, ctx) => ({
      ...s,
      notes: [...s.notes, { id: ctx.id(), text, at: ctx.now() }],
    })),
    // Uses the global clock: not replayable.
    ADD_LEAKY: message(z.object({ text: z.string() }), (s: State, { text }) => ({
      ...s,
      notes: [...s.notes, { id: "x", text, at: Date.now() }],
    })),
  },
  views: { owner: { fn: (s: State) => s }, guest: { fn: (s: State) => s } },
});

/** Build a journal the way the runtime would: each event carries its after-state checksum. */
function journalOf(
  steps: Array<{ event: Omit<JournalEvent, "seq" | "stateChecksum" | "codeVersion" | "createdAt">; after: State }>,
): Journal {
  return {
    events: steps.map((s, i) => ({
      ...s.event,
      seq: i + 1,
      codeVersion: 1,
      createdAt: 0,
      stateChecksum: checksumState({}, s.after),
    })),
    checkpoints: [],
  };
}

const init = {
  causeType: "init" as const,
  name: null,
  payload: { owner: "olive" },
  caller: "svc",
  callerType: "service" as const,
  role: null,
  facts: {},
};
const add = (text: string, id: string, now: number) => ({
  causeType: "message" as const,
  name: "ADD",
  payload: { text },
  caller: "olive",
  callerType: "user" as const,
  role: "owner",
  facts: { ids: [id], now },
});

const s0: State = { owner: "olive", notes: [] };
const s1: State = { owner: "olive", notes: [{ id: "a", text: "one", at: 10 }] };
const s2: State = { owner: "olive", notes: [...s1.notes, { id: "b", text: "two", at: 20 }] };

describe("replayJournal()", () => {
  it("folds the journal through the contract and returns the final state", async () => {
    const journal = journalOf([
      { event: init, after: s0 },
      { event: add("one", "a", 10), after: s1 },
      { event: add("two", "b", 20), after: s2 },
    ]);
    expect(await replayJournal(Notes, journal)).toEqual({ state: s2, replayed: 3 });
  });

  it("throws JournalDivergenceError naming the first event whose checksum differs", async () => {
    const journal = journalOf([
      { event: init, after: s0 },
      { event: add("one", "a", 10), after: s1 },
      { event: add("two", "b", 20), after: { ...s2, owner: "someone else" } },
    ]);
    const error = await replayJournal(Notes, journal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalDivergenceError);
    expect(error).toMatchObject({
      seq: 3,
      causeType: "message",
      causeName: "ADD",
      expected: journal.events[2]?.stateChecksum,
      actual: checksumState({}, s2),
    });
    expect(String(error)).toMatch(/seq 3 \(message ADD\)/);
  });

  it("catches a handler that reads the global clock", async () => {
    const leaky = {
      causeType: "message" as const,
      name: "ADD_LEAKY",
      payload: { text: "t" },
      caller: "olive",
      callerType: "user" as const,
      role: "owner",
      facts: {},
    };
    const journal = journalOf([
      { event: init, after: s0 },
      { event: leaky, after: { owner: "olive", notes: [{ id: "x", text: "t", at: 1 }] } },
    ]);
    await expect(replayJournal(Notes, journal)).rejects.toThrow(NondeterminismError);
  });

  it("surfaces a handler that reads more facts than were recorded", async () => {
    const journal = journalOf([
      { event: init, after: s0 },
      { event: { ...add("one", "a", 10), facts: { now: 10 } }, after: s1 },
    ]);
    await expect(replayJournal(Notes, journal)).rejects.toThrow(JournalNondeterminismError);
  });

  it("starts a pruned journal from the checkpoint just before its first event", async () => {
    const full = journalOf([
      { event: init, after: s0 },
      { event: add("one", "a", 10), after: s1 },
      { event: add("two", "b", 20), after: s2 },
    ]);
    const pruned: Journal = {
      events: full.events.slice(2),
      checkpoints: [{ seq: 2, version: 1, state: JSON.stringify(s1), checksum: checksumState({}, s1) }],
    };
    expect(await replayJournal(Notes, pruned)).toEqual({ state: s2, replayed: 1 });
  });

  it("rejects a pruned journal with no checkpoint to start from", async () => {
    const full = journalOf([
      { event: init, after: s0 },
      { event: add("one", "a", 10), after: s1 },
    ]);
    await expect(replayJournal(Notes, { events: full.events.slice(1), checkpoints: [] })).rejects.toThrow(
      /no checkpoint at seq 1/,
    );
  });

  it("rejects a checkpoint whose state doesn't match its checksum", async () => {
    const full = journalOf([
      { event: init, after: s0 },
      { event: add("one", "a", 10), after: s1 },
    ]);
    const pruned: Journal = {
      events: full.events.slice(1),
      checkpoints: [{ seq: 1, version: 1, state: JSON.stringify(s0), checksum: "0000000000000000" }],
    };
    await expect(replayJournal(Notes, pruned)).rejects.toThrow(JournalDivergenceError);
  });

  it("rejects a gap in the sequence", async () => {
    const full = journalOf([
      { event: init, after: s0 },
      { event: add("one", "a", 10), after: s1 },
      { event: add("two", "b", 20), after: s2 },
    ]);
    const gappy: Journal = { events: [full.events[0], full.events[2]].filter((e) => e !== undefined), checkpoints: [] };
    await expect(replayJournal(Notes, gappy)).rejects.toThrow(/expected seq 2, found 3/);
  });

  it("an empty journal replays to nothing", async () => {
    expect(await replayJournal(Notes, { events: [], checkpoints: [] })).toEqual({ state: undefined, replayed: 0 });
  });
});
