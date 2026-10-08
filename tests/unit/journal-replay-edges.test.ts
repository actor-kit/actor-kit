/**
 * Journal replay edges (ADR-013, ADR-015 D4): facts handed back exactly, corrupt or orphaned
 * events refused with a message naming what is missing, and folding order and checkpoints.
 */
import { xxh64 } from "@actor-kit/core";
import {
  applyJournalEvent,
  checksumState,
  createLiveFacts,
  createReplayFacts,
  foldJournal,
  JournalDivergenceError,
  type JournalEvent,
  JournalNondeterminismError,
  readJournal,
  resolveJournalConfig,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

function ev(partial: Partial<JournalEvent> & Pick<JournalEvent, "causeType">): JournalEvent {
  return {
    seq: 1,
    name: null,
    payload: {},
    caller: null,
    callerType: null,
    role: null,
    facts: {},
    codeVersion: 1,
    stateChecksum: "",
    createdAt: 0,
    ...partial,
  };
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "(no error)";
}

describe("facts", () => {
  it("live facts leave out keys that were never read", () => {
    const facts = createLiveFacts({ now: () => 1, id: () => "x", random: () => 0 }).facts();
    expect(Object.keys(facts)).toEqual([]);
  });

  it("replay hands out unlink targets and link views by name (and id), each once", () => {
    const replay = createReplayFacts({
      unlinked: [
        { name: "a", ids: ["a1"] },
        { name: "b", ids: ["b1"] },
      ],
      linkViews: [
        { name: "room", id: "r1", view: 1 },
        { name: "room", id: "r2", view: 2 },
        { name: "team", id: "r2", view: 3 },
      ],
    });
    expect(replay.takeUnlinked("b")).toEqual(["b1"]);
    expect(replay.takeUnlinked("a")).toEqual(["a1"]);
    expect(replay.takeLinkView("team", "r2")).toBe(3);
    expect(replay.takeLinkView("room", "r2")).toBe(2);
    expect(replay.takeLinkView("room", "r1")).toBe(1);
    expect(() => replay.takeLinkView("room", "r1")).toThrow(JournalNondeterminismError);
  });

  it("says which read was not recorded", () => {
    const replay = createReplayFacts({});
    expect(() => replay.ctx.now()).toThrow(
      "ctx.now() was called on replay but not recorded when the event was written",
    );
    expect(() => replay.ctx.id()).toThrow("ctx.id() was called on replay");
    expect(() => replay.ctx.random()).toThrow("ctx.random() was called on replay");
    expect(() => replay.takeUnlinked("room")).toThrow('unlink("room") was called on replay');
    expect(() => replay.takeLinkView("room", "r1")).toThrow('link("room", "r1") was called on replay');
  });

  it("errors carry their class name", () => {
    expect(new JournalNondeterminismError("x").name).toBe("JournalNondeterminismError");
    expect(new JournalDivergenceError(1, "message", null, "a", "b").name).toBe("JournalDivergenceError");
  });
});

describe("resolveJournalConfig", () => {
  it("accepts checkpointEvery and keep of 1", () => {
    expect(resolveJournalConfig({ keep: 1, checkpointEvery: 1 })).toEqual({
      enabled: true,
      keep: 1,
      checkpointEvery: 1,
    });
  });
});

describe("readJournal", () => {
  const row = {
    seq: 1,
    cause_type: "message",
    name: "X",
    payload: "{}",
    caller: "a",
    caller_type: "service",
    role: "r",
    facts: "{}",
    code_version: 1,
    state_checksum: "c",
    created_at: 0,
  };
  const sql = (events: unknown[]) => ({
    exec: (query: string) => ({ toArray: () => (query.includes("journal_checkpoints") ? [] : events) }),
  });

  it("parses service callers", () => {
    expect(readJournal(sql([row])).events[0]?.callerType).toBe("service");
  });

  it.each([
    [{ unlinked: [{}] }],
    [{ unlinked: [{ name: "a" }] }],
    [{ linkViews: [{ name: "a" }] }],
    [{ linkViews: [{ id: "a", view: 1 }] }],
  ])("rejects facts %j", (facts) => {
    expect(() => readJournal(sql([{ ...row, facts: JSON.stringify(facts) }]))).toThrow();
  });
});

type S = { log: string[] };
const add = {
  schema: z.object({}),
  handler: (s: S, _p: unknown, ctx: { env: unknown }) => ({ log: [...s.log, JSON.stringify(ctx.env)] }),
};

describe("applyJournalEvent refuses what it cannot replay", () => {
  const message = (over: Partial<JournalEvent> = {}) =>
    ev({ causeType: "message", name: "ADD", role: "user", caller: "a", callerType: "user", ...over });

  it("passes the replay env to the handler (default {})", async () => {
    const def = { messages: { user: { ADD: add } } };
    expect(await applyJournalEvent(def, { log: [] }, message(), { env: { E: 1 } })).toEqual({ log: ['{"E":1}'] });
    expect(await applyJournalEvent(def, { log: [] }, message())).toEqual({ log: ["{}"] });
  });

  it.each([
    [{ caller: null }, "has no caller"],
    [{ callerType: null }, "has no caller"],
    [{ name: null }, "has no name"],
    [{ role: null }, "has no role"],
  ])("a message event with %j", async (over, reason) => {
    const def = { messages: { user: { ADD: add } } };
    expect(await failure(() => applyJournalEvent(def, { log: [] }, message(over)))).toContain(reason);
  });

  it("names the message and role that no longer exist, whatever is missing", async () => {
    expect(await failure(() => applyJournalEvent({}, { log: [] }, message()))).toBe(
      'Journal replay: message "ADD" for role "user" is not defined on this actor',
    );
    expect(
      await failure(() => applyJournalEvent({ messages: { admin: { ADD: add } } }, { log: [] }, message())),
    ).toContain('message "ADD" for role "user"');
  });

  it.each([
    ["lifecycle.connect", {}, "lifecycle.connect is not defined"],
    ["lifecycle.connect", { lifecycle: {} }, "lifecycle.connect is not defined"],
    ["lifecycle.disconnect", {}, "lifecycle.disconnect is not defined"],
    ["lifecycle.disconnect", { lifecycle: {} }, "lifecycle.disconnect is not defined"],
  ] as const)("%s without the handler (def %j)", async (causeType, def, reason) => {
    expect(
      await failure(() => applyJournalEvent(def, { log: [] }, ev({ causeType, caller: "a", callerType: "user" }))),
    ).toContain(reason);
  });

  it.each([
    ["service.onDone", {}, 'service "S" onDone is not defined'],
    ["service.onDone", { services: {} }, 'service "S" onDone is not defined'],
    ["service.onDone", { services: { S: {} } }, 'service "S" onDone is not defined'],
    ["service.onError", {}, 'service "S" onError is not defined'],
    ["service.onError", { services: {} }, 'service "S" onError is not defined'],
    ["link.onUpdate", {}, 'link "S" is not defined'],
    ["link.onUpdate", { links: {} }, 'link "S" is not defined'],
    ["link.onError", {}, 'link "S" onError is not defined'],
    ["link.onError", { links: {} }, 'link "S" onError is not defined'],
    ["link.onError", { links: { S: { onUpdate: (s: unknown) => s } } }, 'link "S" onError is not defined'],
  ] as const)("%s without the handler (def %j)", async (causeType, def, reason) => {
    expect(await failure(() => applyJournalEvent(def, { log: [] }, ev({ causeType, name: "S" })))).toContain(reason);
  });

  it.each(["service.onDone", "service.onError", "link.onUpdate", "link.onError"] as const)(
    "%s without a name",
    async (causeType) => {
      expect(await failure(() => applyJournalEvent({}, { log: [] }, ev({ causeType })))).toContain("has no name");
    },
  );

  it("init and migrate without their functions", async () => {
    expect(await failure(() => applyJournalEvent({}, undefined, ev({ causeType: "init" })))).toContain(
      "init is not defined",
    );
    expect(
      await failure(() =>
        applyJournalEvent({}, {}, ev({ causeType: "migrate", payload: { fromVersion: 1, toVersion: 2 } })),
      ),
    ).toContain("migrate is not defined");
  });

  it("restore events are not replayable yet", async () => {
    expect(await failure(() => applyJournalEvent({}, {}, ev({ causeType: "restore" })))).toContain(
      "restore events are not supported",
    );
  });
});

describe("foldJournal", () => {
  type C = { n: number };
  const def = {
    init: (): C => ({ n: 0 }),
    messages: { user: { INC: { handler: (s: C) => ({ n: s.n + 1 }) } } },
  };
  const inc = (seq: number, n: number): JournalEvent =>
    ev({
      seq,
      causeType: "message",
      name: "INC",
      role: "user",
      caller: "a",
      callerType: "user",
      stateChecksum: checksumState({}, { n }),
    });

  it("folds events in seq order whatever order they are given in", async () => {
    const init = ev({ seq: 1, causeType: "init", stateChecksum: checksumState({}, { n: 0 }) });
    const result = await foldJournal(def, { events: [inc(3, 2), init, inc(2, 1)], checkpoints: [] });
    expect(result).toEqual({ state: { n: 2 }, replayed: 3 });
  });

  it("starts a pruned journal from the checkpoint just before its first event", async () => {
    const checkpoint = (seq: number, n: number) => {
      const state = JSON.stringify({ n });
      return { seq, version: 1, state, checksum: xxh64(state) };
    };
    const result = await foldJournal(def, {
      events: [inc(6, 6)],
      checkpoints: [checkpoint(3, 99), checkpoint(5, 5), checkpoint(4, 98)],
    });
    expect(result).toEqual({ state: { n: 6 }, replayed: 1 });
  });

  it("names the checkpoint when its checksum is wrong", async () => {
    const error = await foldJournal(def, {
      events: [inc(6, 6)],
      checkpoints: [{ seq: 5, version: 1, state: '{"n":5}', checksum: "bad" }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalDivergenceError);
    expect(error).toMatchObject({ seq: 5, causeType: "checkpoint", causeName: null, expected: "bad" });
  });

  it("describes a divergence with the cause and, when there is one, its name", () => {
    expect(new JournalDivergenceError(3, "init", null, "a", "b").message).toBe(
      "Journal replay diverged at seq 3 (init): expected checksum a, got b",
    );
    expect(new JournalDivergenceError(4, "message", "INC", "a", "b").message).toBe(
      "Journal replay diverged at seq 4 (message INC): expected checksum a, got b",
    );
  });
});

describe("lifecycle events carry callerConnections", () => {
  type P = { log: string[] };
  const presence = {
    lifecycle: {
      disconnect: (s: P, e: { caller: string; callerConnections?: number }) => ({
        log: [...s.log, `${e.caller}:${e.callerConnections}`],
      }),
    },
  };
  const disconnect = (payload: unknown) =>
    ev({ causeType: "lifecycle.disconnect", caller: "bob", callerType: "user", payload });

  it("replays the recorded count", async () => {
    expect(await applyJournalEvent(presence, { log: [] }, disconnect({ callerConnections: 1 }))).toEqual({
      log: ["bob:1"],
    });
  });

  it("replays events written before it was recorded without one", async () => {
    const seen: unknown[] = [];
    const def = {
      lifecycle: {
        disconnect: (s: P, e: unknown) => {
          seen.push(e);
          return s;
        },
      },
    };
    await applyJournalEvent(def, { log: [] }, disconnect({}));
    expect(seen).toStrictEqual([{ caller: "bob", callerType: "user" }]);
  });

  it("refuses a malformed count", async () => {
    await expect(applyJournalEvent(presence, { log: [] }, disconnect({ callerConnections: "two" }))).rejects.toThrow();
  });
});
