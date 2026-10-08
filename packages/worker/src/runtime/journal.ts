/**
 * Actor journal (ADR-013) — pure pieces shared by the DO runtime and @actor-kit/test.
 *
 * - Facts: what a handler read from the outside world (time, ids, randomness, unlink
 *   targets, init link views), recorded live and handed back on replay.
 * - Events: one row per persisted transition, appended in the same transaction as the state.
 * - applyJournalEvent(): folds one event through the actor's current handlers. Guards
 *   never run and side effects (execute/link/forward) are no-ops.
 */

import type { DeterministicContext } from "@actor-kit/core";
import { xxh64 } from "@actor-kit/core";
import { z } from "zod";

// --- Facts ---

const FactsSchema = z.object({
  now: z.number().optional(),
  ids: z.array(z.string()).optional(),
  randoms: z.array(z.number()).optional(),
  unlinked: z.array(z.object({ name: z.string(), ids: z.array(z.string()) })).optional(),
  linkViews: z.array(z.object({ name: z.string(), id: z.string(), view: z.unknown() })).optional(),
});

export type Facts = z.infer<typeof FactsSchema>;

/** Thrown on replay when a handler reads a fact the journal never recorded. */
export class JournalNondeterminismError extends Error {
  override name = "JournalNondeterminismError";
}

export interface FactSources {
  now(): number;
  id(): string;
  random(): number;
}

const realSources: FactSources = {
  now: () => Date.now(),
  id: () => crypto.randomUUID(),
  random: () => Math.random(),
};

export interface LiveFacts {
  readonly ctx: DeterministicContext;
  recordUnlinked(name: string, ids: string[]): void;
  recordLinkView(name: string, id: string, view: unknown): void;
  /** The facts read so far — only the keys that were used. */
  facts(): Facts;
}

/** Live facts for one transition: read the real sources and record what they returned. */
export function createLiveFacts(sources: FactSources = realSources): LiveFacts {
  let now: number | undefined;
  const ids: string[] = [];
  const randoms: number[] = [];
  const unlinked: { name: string; ids: string[] }[] = [];
  const linkViews: { name: string; id: string; view: unknown }[] = [];

  return {
    ctx: {
      now: () => {
        now ??= sources.now();
        return now;
      },
      id: () => {
        const id = sources.id();
        ids.push(id);
        return id;
      },
      random: () => {
        const r = sources.random();
        randoms.push(r);
        return r;
      },
    },
    recordUnlinked(name, targetIds) {
      unlinked.push({ name, ids: targetIds });
    },
    recordLinkView(name, id, view) {
      linkViews.push({ name, id, view });
    },
    facts() {
      const facts: Facts = {};
      if (now !== undefined) facts.now = now;
      if (ids.length > 0) facts.ids = [...ids];
      if (randoms.length > 0) facts.randoms = [...randoms];
      if (unlinked.length > 0) facts.unlinked = [...unlinked];
      if (linkViews.length > 0) facts.linkViews = [...linkViews];
      return facts;
    },
  };
}

export interface ReplayFacts {
  readonly ctx: DeterministicContext;
  takeUnlinked(name: string): string[];
  takeLinkView(name: string, id: string): unknown;
}

/** Replay facts: hand back what was recorded, in order; reading past the end is non-determinism. */
export function createReplayFacts(facts: Facts): ReplayFacts {
  const ids = [...(facts.ids ?? [])];
  const randoms = [...(facts.randoms ?? [])];
  const unlinked = [...(facts.unlinked ?? [])];
  const linkViews = [...(facts.linkViews ?? [])];
  const missing = (what: string) =>
    new JournalNondeterminismError(`${what} was called on replay but not recorded when the event was written`);

  return {
    ctx: {
      now: () => {
        if (facts.now === undefined) throw missing("ctx.now()");
        return facts.now;
      },
      id: () => {
        const id = ids.shift();
        if (id === undefined) throw missing("ctx.id()");
        return id;
      },
      random: () => {
        const r = randoms.shift();
        if (r === undefined) throw missing("ctx.random()");
        return r;
      },
    },
    takeUnlinked(name) {
      const index = unlinked.findIndex((u) => u.name === name);
      const entry = unlinked[index];
      if (entry === undefined) throw missing(`unlink("${name}")`);
      unlinked.splice(index, 1);
      return entry.ids;
    },
    takeLinkView(name, id) {
      const index = linkViews.findIndex((v) => v.name === name && v.id === id);
      const entry = linkViews[index];
      if (entry === undefined) throw missing(`link("${name}", "${id}")`);
      linkViews.splice(index, 1);
      return entry.view;
    },
  };
}

// --- Config ---

export interface JournalConfig {
  readonly enabled: boolean;
  /** Prune to roughly this many events (never past the newest needed checkpoint). null = keep all. */
  readonly keep: number | null;
  readonly checkpointEvery: number;
}

export type JournalOption = false | { keep?: number; checkpointEvery?: number } | undefined;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}

/** Validate the actor's `journal` option at definition time. */
export function resolveJournalConfig(option: JournalOption): JournalConfig {
  if (option === false) return { enabled: false, keep: null, checkpointEvery: 100 };
  const keep = option?.keep;
  const checkpointEvery = option?.checkpointEvery ?? 100;
  if (keep !== undefined) assertPositiveInteger(keep, "journal.keep");
  assertPositiveInteger(checkpointEvery, "journal.checkpointEvery");
  return { enabled: true, keep: keep ?? null, checkpointEvery };
}

// --- Events ---

export const JOURNAL_CAUSE_TYPES = [
  "init",
  "message",
  "lifecycle.connect",
  "lifecycle.disconnect",
  "service.onDone",
  "service.onError",
  "link.onUpdate",
  "link.onError",
  "migrate",
  "restore",
] as const;

export type JournalCauseType = (typeof JOURNAL_CAUSE_TYPES)[number];

/** What the runtime knows about a transition before it is written. */
export interface JournalDraft {
  readonly causeType: JournalCauseType;
  readonly name: string | null;
  readonly payload: unknown;
  readonly caller: string | null;
  readonly callerType: "user" | "service" | null;
  readonly role: string | null;
  readonly facts: Facts;
}

export interface JournalEvent extends JournalDraft {
  readonly seq: number;
  readonly codeVersion: number;
  readonly stateChecksum: string;
  readonly createdAt: number;
}

export interface JournalCheckpoint {
  readonly seq: number;
  readonly version: number;
  /** serialize(state) as JSON. */
  readonly state: string;
  readonly checksum: string;
}

export interface Journal {
  readonly events: JournalEvent[];
  readonly checkpoints: JournalCheckpoint[];
}

/** Checksum of a state as persisted: xxh64 of JSON.stringify(serialize(state)). */
export function checksumState(def: { serialize?(state: unknown): unknown }, state: unknown): string {
  return xxh64(JSON.stringify(def.serialize ? def.serialize(state) : state));
}

// --- SQL ---

/** The subset of SqlStorage the journal needs (structural, so tests can fake it). */
export interface JournalSql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): unknown[] };
}

export const JOURNAL_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    cause_type TEXT NOT NULL,
    name TEXT,
    payload TEXT NOT NULL,
    caller TEXT,
    caller_type TEXT,
    role TEXT,
    facts TEXT NOT NULL,
    code_version INTEGER NOT NULL,
    state_checksum TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_checkpoints (
    seq INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    checksum TEXT NOT NULL
  );
`;

/**
 * Append one event (and a checkpoint every `checkpointEvery`), then prune if `keep` is set.
 * `seq` is the transition's number (snapshots.last_seq), so effect ids can be derived from it
 * before the event is written. Must run inside the transaction that writes the state.
 */
export function appendJournalEvent(
  sql: JournalSql,
  config: JournalConfig,
  draft: JournalDraft,
  persisted: { seq: number; stateJson: string; checksum: string; version: number; now: number },
): number {
  const row = sql
    .exec(
      "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
      persisted.seq,
      draft.causeType,
      draft.name,
      JSON.stringify(draft.payload ?? null),
      draft.caller,
      draft.callerType,
      draft.role,
      JSON.stringify(draft.facts),
      persisted.version,
      persisted.checksum,
      persisted.now,
    )
    .toArray()[0];
  const seq = z.object({ seq: z.number() }).parse(row).seq;

  if (seq % config.checkpointEvery === 0) {
    sql.exec(
      "INSERT OR REPLACE INTO journal_checkpoints (seq, version, state, checksum) VALUES (?, ?, ?, ?)",
      seq,
      persisted.version,
      persisted.stateJson,
      persisted.checksum,
    );
  }

  if (config.keep !== null) {
    const base = z
      .object({ base: z.number().nullable() })
      .parse(
        sql.exec("SELECT MAX(seq) AS base FROM journal_checkpoints WHERE seq <= ?", seq - config.keep).toArray()[0],
      ).base;
    if (base !== null) {
      sql.exec("DELETE FROM events WHERE seq <= ?", base);
      sql.exec("DELETE FROM journal_checkpoints WHERE seq < ?", base);
    }
  }
  return seq;
}

/**
 * The highest journal seq ever written (SQLite's AUTOINCREMENT high-water mark), 0 if none.
 * Pruning never lowers it, so the next transition's seq never reuses a pruned one.
 */
export function journalHighWater(sql: JournalSql): number {
  const row = sql.exec("SELECT seq FROM sqlite_sequence WHERE name = 'events'").toArray()[0];
  return row === undefined ? 0 : z.object({ seq: z.number() }).parse(row).seq;
}

/**
 * The number of the next transition: one past the larger of snapshots.last_seq and the journal's
 * high-water mark. Read from storage inside the commit's transaction, so it is right even when the
 * snapshot was written by an older deploy or another instance of the object.
 */
export function nextTransitionSeq(sql: JournalSql): number {
  const row = sql.exec("SELECT last_seq FROM snapshots WHERE id = 1").toArray()[0];
  const snapshotSeq = row === undefined ? 0 : z.object({ last_seq: z.number() }).parse(row).last_seq;
  return Math.max(snapshotSeq, journalHighWater(sql)) + 1;
}

const EventRowSchema = z.object({
  seq: z.number(),
  cause_type: z.enum(JOURNAL_CAUSE_TYPES),
  name: z.string().nullable(),
  payload: z.string(),
  caller: z.string().nullable(),
  caller_type: z.enum(["user", "service"]).nullable(),
  role: z.string().nullable(),
  facts: z.string(),
  code_version: z.number(),
  state_checksum: z.string(),
  created_at: z.number(),
});

const CheckpointRowSchema = z.object({
  seq: z.number(),
  version: z.number(),
  state: z.string(),
  checksum: z.string(),
});

/** Read and parse a DO's journal (events + checkpoints), oldest first. */
export function readJournal(sql: JournalSql): Journal {
  const events = sql
    .exec(
      "SELECT seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at FROM events ORDER BY seq",
    )
    .toArray()
    .map((raw): JournalEvent => {
      const row = EventRowSchema.parse(raw);
      const payload: unknown = JSON.parse(row.payload);
      return {
        seq: row.seq,
        causeType: row.cause_type,
        name: row.name,
        payload,
        caller: row.caller,
        callerType: row.caller_type,
        role: row.role,
        facts: FactsSchema.parse(JSON.parse(row.facts)),
        codeVersion: row.code_version,
        stateChecksum: row.state_checksum,
        createdAt: row.created_at,
      };
    });
  const checkpoints = sql
    .exec("SELECT seq, version, state, checksum FROM journal_checkpoints ORDER BY seq")
    .toArray()
    .map((raw): JournalCheckpoint => CheckpointRowSchema.parse(raw));
  return { events, checkpoints };
}

// --- Replay ---

/**
 * The parts of an actor definition replay calls. Runtime-shaped (unknown-typed, bivariant
 * methods); messages are role-nested as the runtime stores them.
 */
export interface ReplayableDef {
  init?(input: unknown, ctx: unknown): unknown;
  messages?: Record<string, Record<string, { handler(state: unknown, payload: unknown, ctx: unknown): unknown }>>;
  lifecycle?: {
    connect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
    disconnect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
  };
  services?: Record<
    string,
    {
      onDone?(state: unknown, result: unknown, input: unknown, ctx: DeterministicContext): unknown;
      onError?(state: unknown, error: { message: string }, input: unknown, ctx: DeterministicContext): unknown;
    }
  >;
  links?: Record<
    string,
    {
      onUpdate(state: unknown, view: unknown, id: string | undefined, ctx: DeterministicContext): unknown;
      onError?:
        | ((
            state: unknown,
            error: { message: string; code: string },
            id: string | undefined,
            ctx: DeterministicContext,
          ) => unknown)
        | undefined;
      onUnlink?: ((state: unknown, id: string | undefined, ctx: DeterministicContext) => unknown) | undefined;
    }
  >;
  migrate?(persisted: unknown, fromVersion: number): unknown;
  serialize?(state: unknown): unknown;
  restore?(serialized: unknown): unknown;
}

const noop = (): void => {};

const ServicePayload = z.object({ input: z.unknown(), result: z.unknown() });
const ServiceErrorPayload = z.object({ input: z.unknown(), error: z.object({ message: z.string() }) });
const LinkUpdatePayload = z.object({ sourceId: z.string(), view: z.unknown() });
const LinkErrorPayload = z.object({
  targetId: z.string(),
  error: z.object({ message: z.string(), code: z.string() }),
});
const MigratePayload = z.object({ fromVersion: z.number(), toVersion: z.number() });

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Journal replay: ${what} is not defined on this actor`);
  return value;
}

function callerOf(event: JournalEvent): { caller: string; callerType: "user" | "service" } {
  if (event.caller === null || event.callerType === null) {
    throw new Error(`Journal replay: event ${event.seq} (${event.causeType}) has no caller`);
  }
  return { caller: event.caller, callerType: event.callerType };
}

/** Fold one journal event through the definition's current handlers. */
export async function applyJournalEvent(
  def: ReplayableDef,
  state: unknown,
  event: JournalEvent,
  options: { env?: unknown } = {},
): Promise<unknown> {
  const env = options.env ?? {};
  const facts = createReplayFacts(event.facts);
  const det = facts.ctx;

  switch (event.causeType) {
    case "init": {
      const init = required(def.init, "init");
      return init(event.payload, {
        env,
        link: async (name: string, id: string) => facts.takeLinkView(name, id),
        ...det,
      });
    }
    case "message": {
      const name = event.name ?? "";
      const role = event.role ?? "";
      const slot = required(def.messages?.[role]?.[name], `message "${name}" for role "${role}"`);
      const { caller, callerType } = callerOf(event);
      const unlinks: { name: string; id: string | undefined }[] = [];
      let next = slot.handler(state, event.payload, {
        caller,
        callerType,
        role,
        env,
        execute: noop,
        link: noop,
        forward: noop,
        unlink: (linkName: string, id?: string) => {
          unlinks.push({ name: linkName, id });
        },
        ...det,
      });
      for (const call of unlinks) {
        const onUnlink = def.links?.[call.name]?.onUnlink;
        if (onUnlink === undefined) continue;
        const ids = call.id !== undefined ? [call.id] : facts.takeUnlinked(call.name);
        for (const id of ids) next = onUnlink(next, id, det);
      }
      return next;
    }
    case "lifecycle.connect":
    case "lifecycle.disconnect": {
      const which = event.causeType === "lifecycle.connect" ? "connect" : "disconnect";
      const handler = required(def.lifecycle?.[which], `lifecycle.${which}`);
      const who = callerOf(event);
      return handler(state, who, { ...who, env, execute: noop, forward: noop, ...det });
    }
    case "service.onDone": {
      const onDone = required(def.services?.[event.name ?? ""]?.onDone, `service "${event.name}" onDone`);
      const { input, result } = ServicePayload.parse(event.payload);
      return onDone(state, result, input, det);
    }
    case "service.onError": {
      const onError = required(def.services?.[event.name ?? ""]?.onError, `service "${event.name}" onError`);
      const { input, error } = ServiceErrorPayload.parse(event.payload);
      return onError(state, error, input, det);
    }
    case "link.onUpdate": {
      const linkDef = required(def.links?.[event.name ?? ""], `link "${event.name}"`);
      const { sourceId, view } = LinkUpdatePayload.parse(event.payload);
      return linkDef.onUpdate(state, view, sourceId, det);
    }
    case "link.onError": {
      const onError = required(def.links?.[event.name ?? ""]?.onError, `link "${event.name}" onError`);
      const { targetId, error } = LinkErrorPayload.parse(event.payload);
      return onError(state, error, targetId, det);
    }
    case "migrate": {
      const migrate = required(def.migrate, "migrate");
      const { fromVersion } = MigratePayload.parse(event.payload);
      const migrated = migrate(def.serialize ? def.serialize(state) : state, fromVersion);
      return def.restore ? def.restore(migrated) : migrated;
    }
    case "restore":
      throw new Error("Journal replay: restore events are not supported yet (ADR-013 step 3)");
  }
}

/** Thrown when a replayed state's checksum differs from the one recorded when the event was written. */
export class JournalDivergenceError extends Error {
  override name = "JournalDivergenceError";
  constructor(
    readonly seq: number,
    readonly causeType: string,
    /** Message, service or link name of the event (null for init, lifecycle, migrate). */
    readonly causeName: string | null,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Journal replay diverged at seq ${seq} (${causeType}${causeName === null ? "" : ` ${causeName}`}): expected checksum ${expected}, got ${actual}`,
    );
  }
}

/**
 * Replay a journal from init (or, for a pruned journal, from the checkpoint just before its
 * first event), verifying every event's after-state checksum. Throws on the first divergence.
 */
export async function foldJournal(
  def: ReplayableDef,
  journal: Journal,
  options: { env?: unknown } = {},
): Promise<{ state: unknown; replayed: number }> {
  const events = [...journal.events].sort((a, b) => a.seq - b.seq);
  const first = events[0];
  if (first === undefined) return { state: undefined, replayed: 0 };

  let state: unknown;
  if (first.causeType !== "init") {
    const baseSeq = first.seq - 1;
    const checkpoint = journal.checkpoints.find((c) => c.seq === baseSeq);
    if (checkpoint === undefined) {
      throw new Error(`Journal replay: no checkpoint at seq ${baseSeq} to start from`);
    }
    const actual = xxh64(checkpoint.state);
    if (actual !== checkpoint.checksum) {
      throw new JournalDivergenceError(checkpoint.seq, "checkpoint", null, checkpoint.checksum, actual);
    }
    const parsed: unknown = JSON.parse(checkpoint.state);
    state = def.restore ? def.restore(parsed) : parsed;
  }

  let expectedSeq = first.seq;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      throw new Error(`Journal replay: expected seq ${expectedSeq}, found ${event.seq}`);
    }
    state = await applyJournalEvent(def, state, event, options);
    const actual = checksumState(def, state);
    if (actual !== event.stateChecksum) {
      throw new JournalDivergenceError(event.seq, event.causeType, event.name, event.stateChecksum, actual);
    }
    expectedSeq += 1;
  }
  return { state, replayed: events.length };
}
