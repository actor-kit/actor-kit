/**
 * Journal rebuild and version checks (ADR-015 D5): rebuild sorts the journal, upcasts only
 * named message payloads (and only when the actor has an upcaster), keeps the env, and refuses
 * a journal that does not start at init; foldJournal refuses events from unknown or newer
 * versions and needs a checkpoint at the version bump.
 */
import {
  checksumState,
  foldJournal,
  type JournalEvent,
  JournalVersionError,
  type ReplayableDef,
  rebuildFromJournal,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Add = z.object({ n: z.number() });
const Env = z.object({ bonus: z.number().optional() });

/** State is a number: init 0, ADD adds n (plus env.bonus), the service's onDone adds its result. */
const base: ReplayableDef = {
  init: () => 0,
  messages: {
    r: {
      ADD: {
        handler: (s: unknown, p: unknown, ctx: unknown) =>
          z.number().parse(s) + Add.parse(p).n + (Env.parse(z.object({ env: z.unknown() }).parse(ctx).env).bonus ?? 0),
      },
    },
  },
  services: { svc: { onDone: (s: unknown, result: unknown) => z.number().parse(s) + z.number().parse(result) } },
};

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
    codeVersion: 1,
    stateChecksum: "",
    createdAt: 0,
    ...over,
  };
}

const add = (seq: number, n: number, after: number, over: Partial<JournalEvent> = {}) =>
  ev(seq, "message", {
    name: "ADD",
    role: "r",
    caller: "u",
    callerType: "user",
    payload: { n },
    stateChecksum: checksumState({}, after),
    ...over,
  });

const init = (over: Partial<JournalEvent> = {}) => ev(1, "init", { stateChecksum: checksumState({}, 0), ...over });

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return "(no error)";
}

async function message(run: () => Promise<unknown>): Promise<string> {
  const error = await failure(run);
  return error instanceof Error ? error.message : String(error);
}

describe("rebuildFromJournal", () => {
  it("refuses an empty journal, naming seq 0", async () => {
    expect(await message(() => rebuildFromJournal(base, { events: [], checkpoints: [] }))).toBe(
      "Rebuilding by replay needs the whole journal: it starts at seq 0",
    );
  });

  it("refuses a journal whose first event is not init, naming its seq", async () => {
    expect(await message(() => rebuildFromJournal(base, { events: [add(4, 1, 1)], checkpoints: [] }))).toBe(
      "Rebuilding by replay needs the whole journal: it starts at seq 4",
    );
  });

  it.each([[[3, 1, 2, 4]], [[4, 3, 2, 1]], [[2, 4, 1, 3]], [[1, 3, 4, 2]]])(
    "sorts the events by seq before folding (%j)",
    async (order) => {
      const bySeq = new Map<number, JournalEvent>([
        [1, init()],
        [2, add(2, 1, 1)],
        [3, add(3, 10, 11)],
        [4, add(4, 100, 111)],
      ]);
      const events = order.flatMap((seq) => bySeq.get(seq) ?? []);
      expect(await rebuildFromJournal(base, { events, checkpoints: [] })).toBe(111);
    },
  );

  it("replays messages as they are when the actor has no upcaster", async () => {
    const events = [init(), add(2, 5, 5), add(3, 7, 12)];
    expect(await rebuildFromJournal(base, { events, checkpoints: [] })).toBe(12);
  });

  it("upcasts message payloads only, never other causes' payloads", async () => {
    const def: ReplayableDef = { ...base, upcast: () => ({ n: 1000, input: null, result: 1000 }) };
    const events = [
      init(),
      add(2, 5, 1000),
      ev(3, "service.onDone", { name: "svc", payload: { input: null, result: 2 }, stateChecksum: "" }),
    ];
    expect(await rebuildFromJournal(def, { events, checkpoints: [] })).toBe(1002);
  });

  it("passes the message name and the version that wrote it to the upcaster", async () => {
    const calls: unknown[] = [];
    const def: ReplayableDef = {
      ...base,
      upcast: (name, payload, from) => {
        calls.push([name, payload, from]);
        return payload;
      },
    };
    const events = [init(), add(2, 5, 5, { codeVersion: 7 })];
    expect(await rebuildFromJournal(def, { events, checkpoints: [] })).toBe(5);
    expect(calls).toEqual([["ADD", { n: 5 }, 7]]);
  });

  it("does not upcast a message journaled without a name: replay refuses it as nameless", async () => {
    const def: ReplayableDef = {
      ...base,
      upcast: () => {
        throw new Error("upcast called");
      },
    };
    const events = [init(), add(2, 5, 5, { name: null })];
    expect(await message(() => rebuildFromJournal(def, { events, checkpoints: [] }))).toBe(
      "Journal replay: event 2 (message) has no name",
    );
  });

  it("keeps the env while rebuilding (handlers read it through ctx.env)", async () => {
    const def: ReplayableDef = { ...base, upcast: (_name, payload) => payload };
    const events = [init(), add(2, 5, 0)];
    expect(await rebuildFromJournal(def, { events, checkpoints: [] }, { env: { bonus: 40 } })).toBe(45);
  });
});

describe("foldJournal version checks", () => {
  it("an empty journal folds to no state", async () => {
    expect(await foldJournal(base, { events: [], checkpoints: [] })).toEqual({ state: undefined, replayed: 0 });
  });

  it("JournalVersionError is named and carries the event, its version and the current one", async () => {
    const def: ReplayableDef = { ...base, version: 3, knownVersions: [1, 3] };
    const error = await failure(() => foldJournal(def, { events: [init({ codeVersion: 2 })], checkpoints: [] }));
    expect(error).toBeInstanceOf(JournalVersionError);
    if (!(error instanceof JournalVersionError)) return;
    expect(error.name).toBe("JournalVersionError");
    expect([error.seq, error.codeVersion, error.currentVersion]).toEqual([1, 2, 3]);
    expect(error.message).toBe("Journal replay: event 1 was written by version 2, which has no path to version 3");
  });

  it("refuses an event from a version newer than the current one, even if it is in the chain", async () => {
    const def: ReplayableDef = { ...base, version: 2, knownVersions: [1, 2, 3] };
    expect(await message(() => foldJournal(def, { events: [init({ codeVersion: 3 })], checkpoints: [] }))).toBe(
      "Journal replay: event 1 was written by version 3, which has no path to version 2",
    );
  });

  it("skips the check when the actor has known versions but no current version", async () => {
    const def: ReplayableDef = { ...base, knownVersions: [1] };
    const events = [init({ codeVersion: 2 }), add(2, 3, 3, { codeVersion: 2 })];
    expect(await foldJournal(def, { events, checkpoints: [] })).toEqual({ state: 3, replayed: 2 });
  });

  it("skips the check when the actor has a version but no known versions", async () => {
    const def: ReplayableDef = { ...base, version: 1 };
    const events = [init(), add(2, 3, 3)];
    expect(await foldJournal(def, { events, checkpoints: [] })).toEqual({ state: 3, replayed: 2 });
  });

  it("folds from init when every event was written by the current version", async () => {
    const def: ReplayableDef = { ...base, version: 1, knownVersions: [1] };
    const events = [init(), add(2, 3, 3), add(3, 4, 7)];
    expect(await foldJournal(def, { events, checkpoints: [] })).toEqual({ state: 7, replayed: 3 });
  });

  it("folds from init when the actor has no version at all", async () => {
    const events = [init({ codeVersion: 9 }), add(2, 3, 3, { codeVersion: 1 })];
    expect(await foldJournal(base, { events, checkpoints: [] })).toEqual({ state: 3, replayed: 2 });
  });

  it("older events with no version bump need a checkpoint at seq 0", async () => {
    const def: ReplayableDef = { ...base, version: 2, knownVersions: [1, 2] };
    const events = [init(), add(2, 3, 3, { codeVersion: 2 })];
    expect(await message(() => foldJournal(def, { events, checkpoints: [] }))).toBe(
      "Journal replay: no checkpoint at the version bump (seq 0)",
    );
  });
});
