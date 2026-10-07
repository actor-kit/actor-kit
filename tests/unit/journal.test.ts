import { xxh64 } from "@actor-kit/core";
import {
  applyJournalEvent,
  checksumState,
  createLiveFacts,
  createReplayFacts,
  type JournalEvent,
  JournalNondeterminismError,
  readJournal,
  resolveJournalConfig,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("createLiveFacts()", () => {
  it("records one timestamp per event, stable across calls", () => {
    let t = 1000;
    const live = createLiveFacts({ now: () => t++, id: () => "x", random: () => 0.5 });
    expect(live.ctx.now()).toBe(1000);
    expect(live.ctx.now()).toBe(1000);
    expect(live.facts()).toEqual({ now: 1000 });
  });

  it("records ids and randoms in call order", () => {
    const ids = ["a", "b"];
    const rs = [0.1, 0.2];
    const live = createLiveFacts({ now: () => 1, id: () => ids.shift() ?? "", random: () => rs.shift() ?? 0 });
    expect([live.ctx.id(), live.ctx.random(), live.ctx.id(), live.ctx.random()]).toEqual(["a", 0.1, "b", 0.2]);
    expect(live.facts()).toEqual({ ids: ["a", "b"], randoms: [0.1, 0.2] });
  });

  it("records nothing when nothing is read", () => {
    expect(createLiveFacts().facts()).toEqual({});
  });

  it("defaults to the real clock, crypto.randomUUID and Math.random", () => {
    const live = createLiveFacts();
    const before = Date.now();
    const now = live.ctx.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(live.ctx.id()).toMatch(/^[0-9a-f-]{36}$/);
    const r = live.ctx.random();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it("records unlinked targets and init link views", () => {
    const live = createLiveFacts();
    live.recordUnlinked("room", ["r1", "r2"]);
    live.recordLinkView("profile", "p1", { role: "public", name: "A" });
    expect(live.facts()).toEqual({
      unlinked: [{ name: "room", ids: ["r1", "r2"] }],
      linkViews: [{ name: "profile", id: "p1", view: { role: "public", name: "A" } }],
    });
  });
});

describe("createReplayFacts()", () => {
  it("returns the recorded values in order", () => {
    const replay = createReplayFacts({ now: 5, ids: ["a", "b"], randoms: [0.3] });
    expect(replay.ctx.now()).toBe(5);
    expect(replay.ctx.now()).toBe(5);
    expect(replay.ctx.id()).toBe("a");
    expect(replay.ctx.id()).toBe("b");
    expect(replay.ctx.random()).toBe(0.3);
  });

  it("throws JournalNondeterminismError when a handler reads more than was recorded", () => {
    const replay = createReplayFacts({ ids: ["a"] });
    replay.ctx.id();
    expect(() => replay.ctx.id()).toThrow(JournalNondeterminismError);
    expect(() => replay.ctx.random()).toThrow(/ctx\.random\(\)/);
    expect(() => replay.ctx.now()).toThrow(/ctx\.now\(\)/);
  });

  it("hands out unlinked targets and link views per name, in order", () => {
    const replay = createReplayFacts({
      unlinked: [{ name: "room", ids: ["r1"] }],
      linkViews: [
        { name: "p", id: "1", view: { v: 1 } },
        { name: "p", id: "2", view: { v: 2 } },
      ],
    });
    expect(replay.takeUnlinked("room")).toEqual(["r1"]);
    expect(() => replay.takeUnlinked("room")).toThrow(JournalNondeterminismError);
    expect(replay.takeLinkView("p", "1")).toEqual({ v: 1 });
    expect(replay.takeLinkView("p", "2")).toEqual({ v: 2 });
    expect(() => replay.takeLinkView("p", "3")).toThrow(JournalNondeterminismError);
  });
});

describe("resolveJournalConfig()", () => {
  it("defaults to on, keep everything, checkpoint every 100", () => {
    expect(resolveJournalConfig(undefined)).toEqual({ enabled: true, keep: null, checkpointEvery: 100 });
  });

  it("journal: false turns it off", () => {
    expect(resolveJournalConfig(false).enabled).toBe(false);
  });

  it("accepts keep and checkpointEvery", () => {
    expect(resolveJournalConfig({ keep: 500, checkpointEvery: 10 })).toEqual({
      enabled: true,
      keep: 500,
      checkpointEvery: 10,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects keep = %s", (keep) => {
    expect(() => resolveJournalConfig({ keep })).toThrow(/journal\.keep/);
  });

  it.each([0, -1, 2.5])("rejects checkpointEvery = %s", (checkpointEvery) => {
    expect(() => resolveJournalConfig({ checkpointEvery })).toThrow(/journal\.checkpointEvery/);
  });
});

describe("checksumState()", () => {
  it("is xxh64 of the JSON of the state", () => {
    expect(checksumState({}, { a: 1 })).toBe(xxh64('{"a":1}'));
  });

  it("serializes first when the def has serialize()", () => {
    const def = { serialize: (s: unknown) => ({ wrapped: s }) };
    expect(checksumState(def, 1)).toBe(xxh64('{"wrapped":1}'));
  });
});

// --- applyJournalEvent ---

type S = { log: string[] };

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

const def = {
  init: (input: unknown, ctx: { now(): number; link(name: string, id: string): Promise<unknown> }) =>
    ctx
      .link("profile", "p1")
      .then((view) => ({ log: [`init:${JSON.stringify(input)}:${ctx.now()}:${JSON.stringify(view)}`] })),
  messages: {
    user: {
      ADD: {
        schema: z.object({ text: z.string() }),
        guard: () => false,
        handler: (
          s: S,
          p: { text: string },
          ctx: { caller: string; role: string; id(): string; unlink(n: string, id?: string): void },
        ) => {
          ctx.unlink("room");
          return { log: [...s.log, `add:${p.text}:${ctx.caller}:${ctx.role}:${ctx.id()}`] };
        },
      },
    },
  },
  lifecycle: {
    connect: (s: S, e: { caller: string }, ctx: { now(): number }) => ({
      log: [...s.log, `connect:${e.caller}:${ctx.now()}`],
    }),
    disconnect: (s: S, e: { caller: string; callerType: string }) => ({
      log: [...s.log, `disconnect:${e.caller}:${e.callerType}`],
    }),
  },
  services: {
    FETCH: {
      fn: async () => null,
      onDone: (s: S, result: unknown, input: unknown, ctx: { random(): number }) => ({
        log: [...s.log, `done:${JSON.stringify(result)}:${JSON.stringify(input)}:${ctx.random()}`],
      }),
      onError: (s: S, error: { message: string }, input: unknown) => ({
        log: [...s.log, `error:${error.message}:${JSON.stringify(input)}`],
      }),
    },
  },
  links: {
    room: {
      onUpdate: (s: S, view: unknown, id: string | undefined, ctx: { now(): number }) => ({
        log: [...s.log, `update:${id}:${JSON.stringify(view)}:${ctx.now()}`],
      }),
      onError: (s: S, error: { message: string; code: string }, id?: string) => ({
        log: [...s.log, `linkError:${id}:${error.code}`],
      }),
      onUnlink: (s: S, id?: string) => ({ log: [...s.log, `unlink:${id}`] }),
    },
  },
  migrate: (persisted: unknown, from: number) => ({ migrated: from, persisted }),
  serialize: (s: unknown) => ({ ser: s }),
  restore: (raw: unknown) => ({ log: [`restored:${JSON.stringify(raw)}`] }),
};

describe("applyJournalEvent()", () => {
  it("init: calls init with the input, recorded link views and facts", async () => {
    const next = await applyJournalEvent(
      def,
      undefined,
      ev({
        causeType: "init",
        payload: { a: 1 },
        facts: { now: 9, linkViews: [{ name: "profile", id: "p1", view: { n: 1 } }] },
      }),
    );
    expect(next).toEqual({ log: ['init:{"a":1}:9:{"n":1}'] });
  });

  it("message: runs the handler without its guard, then onUnlink for recorded unlink targets", async () => {
    const next = await applyJournalEvent(
      def,
      { log: [] },
      ev({
        causeType: "message",
        name: "ADD",
        payload: { text: "hi" },
        caller: "alice",
        callerType: "user",
        role: "user",
        facts: { ids: ["m1"], unlinked: [{ name: "room", ids: ["r1", "r2"] }] },
      }),
    );
    expect(next).toEqual({ log: ["add:hi:alice:user:m1", "unlink:r1", "unlink:r2"] });
  });

  it("message: throws when the message no longer exists for the recorded role", async () => {
    await expect(
      applyJournalEvent(def, { log: [] }, ev({ causeType: "message", name: "GONE", role: "user" })),
    ).rejects.toThrow(/GONE/);
  });

  it("lifecycle.connect / lifecycle.disconnect", async () => {
    const a = await applyJournalEvent(
      def,
      { log: [] },
      ev({ causeType: "lifecycle.connect", caller: "bob", callerType: "user", role: "user", facts: { now: 3 } }),
    );
    const b = await applyJournalEvent(
      def,
      a,
      ev({ causeType: "lifecycle.disconnect", caller: "bob", callerType: "service", role: "user" }),
    );
    expect(b).toEqual({ log: ["connect:bob:3", "disconnect:bob:service"] });
  });

  it("service.onDone / service.onError", async () => {
    const a = await applyJournalEvent(
      def,
      { log: [] },
      ev({
        causeType: "service.onDone",
        name: "FETCH",
        payload: { input: { q: 1 }, result: [2] },
        facts: { randoms: [0.5] },
      }),
    );
    const b = await applyJournalEvent(
      def,
      a,
      ev({ causeType: "service.onError", name: "FETCH", payload: { input: { q: 1 }, error: { message: "boom" } } }),
    );
    expect(b).toEqual({ log: ['done:[2]:{"q":1}:0.5', 'error:boom:{"q":1}'] });
  });

  it("link.onUpdate / link.onError", async () => {
    const a = await applyJournalEvent(
      def,
      { log: [] },
      ev({
        causeType: "link.onUpdate",
        name: "room",
        payload: { sourceId: "r1", view: { role: "x" } },
        facts: { now: 4 },
      }),
    );
    const b = await applyJournalEvent(
      def,
      a,
      ev({
        causeType: "link.onError",
        name: "room",
        payload: { targetId: "r2", error: { message: "m", code: "unreachable" } },
      }),
    );
    expect(b).toEqual({ log: ['update:r1:{"role":"x"}:4', "linkError:r2:unreachable"] });
  });

  it("migrate: restore(migrate(serialize(state), fromVersion))", async () => {
    const next = await applyJournalEvent(
      def,
      { log: ["a"] },
      ev({ causeType: "migrate", payload: { fromVersion: 1, toVersion: 2 } }),
    );
    expect(next).toEqual({ log: ['restored:{"migrated":1,"persisted":{"ser":{"log":["a"]}}}'] });
  });

  it("throws on a cause whose handler is missing", async () => {
    await expect(
      applyJournalEvent(
        {},
        { log: [] },
        ev({ causeType: "service.onDone", name: "NOPE", payload: { input: 1, result: 2 } }),
      ),
    ).rejects.toThrow(/NOPE/);
  });

  it("never runs side effects: execute/link/forward are no-ops", async () => {
    const effects = {
      messages: {
        user: {
          GO: {
            schema: z.object({}),
            handler: (
              s: S,
              _p: unknown,
              ctx: {
                execute(n: string, i: unknown): void;
                link(n: string, id: string): void;
                forward(l: string, t: string, m: { type: string }): void;
              },
            ) => {
              ctx.execute("X", 1);
              ctx.link("room", "r");
              ctx.forward("room", "r", { type: "Y" });
              return { log: [...s.log, "go"] };
            },
          },
        },
      },
    };
    const next = await applyJournalEvent(
      effects,
      { log: [] },
      ev({ causeType: "message", name: "GO", role: "user", caller: "a", callerType: "user" }),
    );
    expect(next).toEqual({ log: ["go"] });
  });
});

// --- readJournal ---

function fakeSql(tables: { events: unknown[]; journal_checkpoints: unknown[] }) {
  return {
    exec(query: string) {
      const rows = query.includes("journal_checkpoints") ? tables.journal_checkpoints : tables.events;
      return { toArray: () => rows };
    },
  };
}

describe("readJournal()", () => {
  it("parses event and checkpoint rows", () => {
    const journal = readJournal(
      fakeSql({
        events: [
          {
            seq: 1,
            cause_type: "message",
            name: "ADD",
            payload: '{"text":"hi"}',
            caller: "alice",
            caller_type: "user",
            role: "user",
            facts: '{"now":5}',
            code_version: 2,
            state_checksum: "abc",
            created_at: 10,
          },
        ],
        journal_checkpoints: [{ seq: 1, version: 2, state: '{"log":[]}', checksum: "abc" }],
      }),
    );
    expect(journal).toEqual({
      events: [
        {
          seq: 1,
          causeType: "message",
          name: "ADD",
          payload: { text: "hi" },
          caller: "alice",
          callerType: "user",
          role: "user",
          facts: { now: 5 },
          codeVersion: 2,
          stateChecksum: "abc",
          createdAt: 10,
        },
      ],
      checkpoints: [{ seq: 1, version: 2, state: '{"log":[]}', checksum: "abc" }],
    });
  });

  it("rejects a row with an unknown cause type", () => {
    const bad = {
      seq: 1,
      cause_type: "nope",
      name: null,
      payload: "{}",
      caller: null,
      caller_type: null,
      role: null,
      facts: "{}",
      code_version: 1,
      state_checksum: "a",
      created_at: 1,
    };
    expect(() => readJournal(fakeSql({ events: [bad], journal_checkpoints: [] }))).toThrow();
  });

  it("rejects facts of the wrong shape", () => {
    const bad = {
      seq: 1,
      cause_type: "init",
      name: null,
      payload: "{}",
      caller: null,
      caller_type: null,
      role: null,
      facts: '{"ids":[1]}',
      code_version: 1,
      state_checksum: "a",
      created_at: 1,
    };
    expect(() => readJournal(fakeSql({ events: [bad], journal_checkpoints: [] }))).toThrow();
  });
});
