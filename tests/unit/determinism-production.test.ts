/**
 * ADR-018 E: determinism in production. `determinism: "warn"` (the default) reports each call of a
 * nondeterministic global, answers it with the real global, flags the journal entry and logs one line;
 * "throw" throws (tests always do); "off" patches nothing.
 */
import {
  ACTOR_KIT_MIGRATIONS,
  appendJournalEvent,
  determinismWatch,
  flagNondeterministic,
  type JournalDraft,
  NondeterminismError,
  nondeterministicEvent,
  readJournal,
  resolveDeterminism,
  resolveJournalConfig,
  timelineEntry,
  type Violation,
  withDeterminismGuard,
  withDeterminismWarnings,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { createNodeSql } from "./helpers/node-sql";

const reads: Array<[string, string, () => unknown]> = [
  ["Date.now()", "ctx.now()", () => Date.now()],
  ["new Date()", "ctx.now()", () => new Date()],
  ["Date()", "ctx.now()", () => Date()],
  ["performance.now()", "ctx.now()", () => performance.now()],
  ["Math.random()", "ctx.random()", () => Math.random()],
  ["crypto.randomUUID()", "ctx.id()", () => crypto.randomUUID()],
  ["crypto.getRandomValues()", "ctx.random()", () => crypto.getRandomValues(new Uint8Array(4))],
];

describe("withDeterminismWarnings", () => {
  it.each(reads)("reports %s with what to use, and answers with the real value", (what, use, read) => {
    const seen: Violation[] = [];
    const value = withDeterminismWarnings((v) => seen.push(v), read);
    expect(seen).toEqual([{ what, use }]);
    expect(value).not.toBeUndefined();
  });

  it("answers with real values (a real clock, a real UUID, a real Date)", () => {
    const before = Date.now();
    const [now, date, id, random] = withDeterminismWarnings(
      () => {},
      () => [Date.now(), new Date(), crypto.randomUUID(), Math.random()] as const,
    );
    expect(now).toBeGreaterThanOrEqual(before);
    expect(date).toBeInstanceOf(Date);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(random).toBeGreaterThanOrEqual(0);
    expect(
      typeof withDeterminismWarnings(
        () => {},
        () => Date(),
      ),
    ).toBe("string");
  });

  it("leaves the forms with arguments alone and restores every global afterwards", () => {
    const seen: Violation[] = [];
    const parsed = withDeterminismWarnings(
      (v) => seen.push(v),
      () => [new Date(0).getTime(), Date.UTC(2020, 0), Date.parse("1970-01-01T00:00:00Z")],
    );
    expect(parsed).toEqual([0, Date.UTC(2020, 0), 0]);
    expect(seen).toEqual([]);
    const seenAfter: Violation[] = [];
    expect(() => Date.now()).not.toThrow();
    expect(seenAfter).toEqual([]);
  });

  it("guards nest: the outermost decides (warn inside throw throws, throw inside warn reports)", () => {
    const seen: Violation[] = [];
    let error: unknown;
    withDeterminismGuard(() => {
      try {
        withDeterminismWarnings(
          (v) => seen.push(v),
          () => Math.random(),
        );
      } catch (e) {
        error = e;
      }
    });
    expect(error).toBeInstanceOf(NondeterminismError);
    expect(seen).toEqual([]);
    withDeterminismWarnings(
      (v) => seen.push(v),
      () => withDeterminismGuard(() => Math.random()),
    );
    expect(seen).toEqual([{ what: "Math.random()", use: "ctx.random()" }]);
  });
});

describe("determinismWatch and the journal flag", () => {
  it("off: no guard; throw: the throwing guard; warn: a guard that collects calls", () => {
    expect(determinismWatch("off")).toEqual({ guard: undefined, violations: [] });
    expect(determinismWatch("throw")).toEqual({ guard: withDeterminismGuard, violations: [] });
    const watch = determinismWatch("warn");
    expect(watch.guard?.(() => Math.random() >= 0)).toBe(true);
    expect(watch.violations).toEqual([{ what: "Math.random()", use: "ctx.random()" }]);
  });

  it("resolveDeterminism: default warn, the three modes, anything else refused with its code", () => {
    expect([undefined, "throw", "warn", "off"].map(resolveDeterminism)).toEqual(["warn", "throw", "warn", "off"]);
    let thrown: unknown;
    try {
      resolveDeterminism("loud");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "invalid_determinism_option",
      message: 'Invalid determinism option "loud": use "throw", "warn" or "off" (default "warn").',
    });
  });

  it("flagNondeterministic marks a draft only when calls were reported", () => {
    const draft = { causeType: "message", name: "M" };
    expect(flagNondeterministic(draft, [])).toBe(draft);
    expect(flagNondeterministic(draft, [{ what: "Date.now()", use: "ctx.now()" }])).toEqual({
      ...draft,
      nondeterministic: true,
    });
  });

  it("logs one line per transition, each global once", () => {
    const violations = [
      { what: "Date.now()", use: "ctx.now()" },
      { what: "Math.random()", use: "ctx.random()" },
      { what: "Date.now()", use: "ctx.now()" },
    ];
    expect(nondeterministicEvent("game", "g1", { causeType: "message", name: "MOVE" }, violations)).toEqual({
      event: "actor_kit.handler.nondeterministic",
      actorType: "game",
      actorId: "g1",
      causeType: "message",
      name: "MOVE",
      calls: ["Date.now()", "Math.random()"],
      use: ["ctx.now()", "ctx.random()"],
    });
  });

  it("the flag is stored on the journal entry and shown in the timeline", () => {
    const sql = createNodeSql();
    for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
    const draft: JournalDraft = {
      causeType: "message",
      name: "M",
      payload: {},
      caller: "u",
      callerType: "user",
      role: "r",
      facts: {},
    };
    const persisted = (seq: number) => ({ seq, stateJson: "{}", checksum: "c", version: 1, now: 0 });
    appendJournalEvent(sql, resolveJournalConfig(undefined), { ...draft, nondeterministic: true }, persisted(1));
    appendJournalEvent(sql, resolveJournalConfig(undefined), draft, persisted(2));
    const [flagged, clean] = readJournal(sql).events;
    expect(flagged?.nondeterministic).toBe(true);
    expect(clean !== undefined && "nondeterministic" in clean).toBe(false);
    if (flagged === undefined || clean === undefined) throw new Error("missing events");
    expect(timelineEntry(flagged, null, (l) => l).nondeterministic).toBe(true);
    expect(timelineEntry(clean, null, (l) => l).nondeterministic).toBe(false);
  });
});
