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
import { ActorKitError, xxh64 } from "@actor-kit/core";
import { z } from "zod";
import { realSources as guardedRealSources } from "./determinism";
import { DeliveryInfoSchema } from "./effect-info";
import type { TimerOp } from "./outbox";
import { findTimer, messageSlot, phaseOf, replayStepFacts, type StepCause, type StepDef, step, stepInit } from "./step";
import type { Trace } from "./trace";

// --- Facts ---

const FactsSchema = z.object({
  now: z.number().optional(),
  ids: z.array(z.string()).optional(),
  randoms: z.array(z.number()).optional(),
  unlinked: z.array(z.object({ name: z.string(), ids: z.array(z.string()) })).optional(),
  linkViews: z.array(z.object({ name: z.string(), id: z.string(), view: z.unknown() })).optional(),
  /** The forward that delivered a message (ADR-016 §1), handed back to the handler as ctx.delivery. */
  delivery: DeliveryInfoSchema.optional(),
});

export type Facts = z.infer<typeof FactsSchema>;

/** Thrown on replay when a handler reads a fact the journal never recorded. */
export class JournalNondeterminismError extends ActorKitError {
  override name = "JournalNondeterminismError";
  constructor(message: string) {
    super("journal_nondeterminism", message);
  }
}

export interface FactSources {
  now(): number;
  id(): string;
  random(): number;
}

// The real clock and randomness, read through the determinism guard's saved originals while a guarded
// handler runs (ADR-016 §5), so ctx.now()/id()/random() keep working inside it.
const realSources: FactSources = {
  now: () => guardedRealSources.now(),
  id: () => guardedRealSources.randomUUID(),
  random: () => guardedRealSources.random(),
};

/** The real sources with the clock pinned to `now` (a timer runs on its alarm's clock). */
export function clockedSources(now: number): FactSources {
  return { ...realSources, now: () => now };
}

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
    throw new ActorKitError("invalid_journal_option", `${name} must be a positive integer, got ${value}`);
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
  "timer",
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
  /** The flow this transition continues (ADR-017 §4); absent when it starts one. */
  readonly trace?: Trace;
  /** Domain events the transition emitted, in order (ADR-017 §2); absent when none. */
  readonly emitted?: readonly EmittedEvent[];
}

export interface EmittedEvent {
  readonly name: string;
  readonly payload: unknown;
}

export interface JournalEvent extends JournalDraft {
  readonly seq: number;
  readonly codeVersion: number;
  readonly stateChecksum: string;
  readonly createdAt: number;
  /** The flow's id (ADR-017 §4). Absent from events written before ADR-017. */
  readonly correlationId?: string;
  /** The event or effect that caused this one; absent when the event started its flow. */
  readonly causationId?: string;
}

export interface JournalCheckpoint {
  readonly seq: number;
  readonly version: number;
  /** serialize(state) as JSON. */
  readonly state: string;
  readonly checksum: string;
  /** The timers pending at this seq, as JSON (ADR-015 D3). Absent from checkpoints written before. */
  readonly timers?: string | undefined;
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
  persisted: PersistedEvent,
): number {
  const seq = insertEvent(sql, draft, persisted);

  // A version bump always checkpoints: replay across it starts there (ADR-015 D5).
  if (seq % config.checkpointEvery === 0 || draft.causeType === "migrate") {
    sql.exec(
      "INSERT OR REPLACE INTO journal_checkpoints (seq, version, state, checksum, timers) VALUES (?, ?, ?, ?, ?)",
      seq,
      persisted.version,
      persisted.stateJson,
      persisted.checksum,
      JSON.stringify(pendingTimers(sql)),
    );
  }

  if (config.keep !== null) pruneJournal(sql, seq - config.keep);
  return seq;
}

/** What the transaction knows about the event besides its cause: its seq, state, version and ids. */
interface PersistedEvent {
  seq: number;
  stateJson: string;
  checksum: string;
  version: number;
  now: number;
  /** ADR-017 §4: the flow's id and what caused the event (null when it starts the flow). */
  correlationId?: string;
  causationId?: string | null;
}

function insertEvent(sql: JournalSql, draft: JournalDraft, persisted: PersistedEvent): number {
  const row = sql
    .exec(
      "INSERT INTO events (seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at, correlation_id, causation_id, emitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
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
      persisted.correlationId ?? null,
      persisted.causationId ?? null,
      draft.emitted === undefined ? null : JSON.stringify(draft.emitted),
    )
    .toArray()[0];
  return z.object({ seq: z.number() }).parse(row).seq;
}

/** Keep the newest checkpoint at or before `upTo` and everything after it. */
function pruneJournal(sql: JournalSql, upTo: number): void {
  const base = z
    .object({ base: z.number().nullable() })
    .parse(sql.exec("SELECT MAX(seq) AS base FROM journal_checkpoints WHERE seq <= ?", upTo).toArray()[0]).base;
  if (base !== null) {
    sql.exec("DELETE FROM events WHERE seq <= ?", base);
    sql.exec("DELETE FROM journal_checkpoints WHERE seq < ?", base);
  }
}

const TimerTableRow = z.object({
  id: z.string(),
  seq: z.number(),
  idx: z.number(),
  name: z.string(),
  key: z.string(),
  payload: z.string(),
  fire_at: z.number(),
});

/** The timers table as of now (inside the transaction), for a checkpoint. */
function pendingTimers(sql: JournalSql): ScheduledTimer[] {
  return sql
    .exec("SELECT id, seq, idx, name, key, payload, fire_at FROM timers ORDER BY fire_at, seq, idx")
    .toArray()
    .map((raw) => {
      const row = TimerTableRow.parse(raw);
      const payload: unknown = JSON.parse(row.payload);
      return { id: row.id, seq: row.seq, index: row.idx, name: row.name, key: row.key, payload, fireAt: row.fire_at };
    });
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
  return Math.max(snapshotSeq(sql), journalHighWater(sql)) + 1;
}

/**
 * The seq of the transition that made the stored state (snapshots.last_seq), 0 before the first.
 * Kept with or without the journal (ADR-015 D1), so it numbers what a view was made from: a link
 * push carries it as its version, and a subscriber drops a push whose seq it already has.
 */
export function snapshotSeq(sql: JournalSql): number {
  const row = sql.exec("SELECT last_seq FROM snapshots WHERE id = 1").toArray()[0];
  return row === undefined ? 0 : z.object({ last_seq: z.number() }).parse(row).last_seq;
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
  // Absent from rows selected by readers that predate ADR-017, NULL on rows written before it.
  correlation_id: z.string().nullish(),
  causation_id: z.string().nullish(),
  emitted: z.string().nullish(),
});

const EmittedSchema = z.array(z.object({ name: z.string(), payload: z.unknown() }));

const CheckpointRowSchema = z.object({
  seq: z.number(),
  version: z.number(),
  state: z.string(),
  checksum: z.string(),
  timers: z.string().optional(),
});

/** The `events` columns, in the order every reader selects them. */
export const JOURNAL_EVENT_COLUMNS =
  "seq, cause_type, name, payload, caller, caller_type, role, facts, code_version, state_checksum, created_at, correlation_id, causation_id, emitted";

/** Parse one `events` row (selected with JOURNAL_EVENT_COLUMNS) at the storage boundary. */
export function parseJournalEventRow(raw: unknown): JournalEvent {
  const row = EventRowSchema.parse(raw);
  const payload: unknown = JSON.parse(row.payload);
  const event: JournalEvent = {
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
  const traced = withIds(event, row.correlation_id ?? null, row.causation_id ?? null);
  const emitted = row.emitted ?? null;
  return emitted === null ? traced : { ...traced, emitted: EmittedSchema.parse(JSON.parse(emitted)) };
}

/** The event with the ids that were recorded (none for rows written before ADR-017). */
function withIds(event: JournalEvent, correlationId: string | null, causationId: string | null): JournalEvent {
  const correlated = correlationId === null ? event : { ...event, correlationId };
  return causationId === null ? correlated : { ...correlated, causationId };
}

/** Parse one `journal_checkpoints` row at the storage boundary. */
export function parseCheckpointRow(raw: unknown): JournalCheckpoint {
  return CheckpointRowSchema.parse(raw);
}

/** Read and parse a DO's journal (events + checkpoints), oldest first. */
export function readJournal(sql: JournalSql): Journal {
  const events = sql
    .exec(`SELECT ${JOURNAL_EVENT_COLUMNS} FROM events ORDER BY seq`)
    .toArray()
    .map(parseJournalEventRow);
  const checkpoints = sql.exec("SELECT * FROM journal_checkpoints ORDER BY seq").toArray().map(parseCheckpointRow);
  return { events, checkpoints };
}

// --- Replay ---

/**
 * The parts of an actor definition replay calls: the step core's definition (runtime-shaped,
 * unknown-typed, bivariant methods; messages role-nested as the runtime stores them).
 */
export type ReplayableDef = StepDef;

const ServicePayload = z.object({ input: z.unknown(), result: z.unknown(), effectId: z.string().optional() });
/** The error is journaled as the runtime parsed it (ADR-016 §2): replay delivers the same typed value. */
const ServiceErrorPayload = z.object({
  input: z.unknown(),
  error: z.record(z.string(), z.unknown()),
  effectId: z.string().optional(),
});
const LinkUpdatePayload = z.object({ sourceId: z.string(), view: z.unknown() });
const LinkErrorPayload = z.object({
  targetId: z.string(),
  error: z.object({ message: z.string(), code: z.string() }),
});
/** Lifecycle events journal callerConnections (events written before it was recorded have `{}`). */
const LifecyclePayload = z.object({ callerConnections: z.number().optional() });
const MigratePayload = z.object({ fromVersion: z.number(), toVersion: z.number() });
const TimerPayload = z.object({
  id: z.string(),
  key: z.string(),
  payload: z.unknown(),
  fireAt: z.number(),
  lateBy: z.number(),
});

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined)
    throw new ActorKitError("journal_invalid", `Journal replay: ${what} is not defined on this actor`);
  return value;
}

function callerOf(event: JournalEvent): { caller: string; callerType: "user" | "service" } {
  if (event.caller === null || event.callerType === null) {
    throw new ActorKitError("journal_invalid", `Journal replay: event ${event.seq} (${event.causeType}) has no caller`);
  }
  return { caller: event.caller, callerType: event.callerType };
}

/** The message, service or link name an event was journaled under. */
function nameOf(event: JournalEvent): string {
  if (event.name === null)
    throw new ActorKitError("journal_invalid", `Journal replay: event ${event.seq} (${event.causeType}) has no name`);
  return event.name;
}

function roleOf(event: JournalEvent): string {
  if (event.role === null)
    throw new ActorKitError("journal_invalid", `Journal replay: event ${event.seq} (${event.causeType}) has no role`);
  return event.role;
}

function lifecycleCause(type: "lifecycle.connect" | "lifecycle.disconnect", event: JournalEvent): StepCause {
  const cause = { type, role: event.role, ...callerOf(event) };
  const { callerConnections } = LifecyclePayload.parse(event.payload);
  return callerConnections === undefined ? cause : { ...cause, callerConnections };
}

type ReplayCause = (def: ReplayableDef, state: unknown, event: JournalEvent) => StepCause;

/** How each journaled cause becomes a step cause again. Handlers that are gone fail loudly. */
const REPLAY_CAUSES: Record<Exclude<JournalCauseType, "init" | "restore">, ReplayCause> = {
  message: (def, state, event) => {
    const name = nameOf(event);
    const role = roleOf(event);
    required(messageSlot(def, state, role, name), `message "${name}" for role "${role}"`);
    return { type: "message", name, payload: event.payload, role, ...callerOf(event), delivery: event.facts.delivery };
  },
  "lifecycle.connect": (def, _state, event) => {
    required(def.lifecycle?.connect, "lifecycle.connect");
    return lifecycleCause("lifecycle.connect", event);
  },
  "lifecycle.disconnect": (def, _state, event) => {
    required(def.lifecycle?.disconnect, "lifecycle.disconnect");
    return lifecycleCause("lifecycle.disconnect", event);
  },
  "service.onDone": (def, _state, event) => {
    const service = nameOf(event);
    required(def.services?.[service]?.onDone, `service "${service}" onDone`);
    return { type: "service.onDone", service, ...ServicePayload.parse(event.payload) };
  },
  "service.onError": (def, _state, event) => {
    const service = nameOf(event);
    required(def.services?.[service]?.onError, `service "${service}" onError`);
    return { type: "service.onError", service, ...ServiceErrorPayload.parse(event.payload) };
  },
  "link.onUpdate": (def, _state, event) => {
    const link = nameOf(event);
    required(def.links?.[link], `link "${link}"`);
    return { type: "link.onUpdate", link, ...LinkUpdatePayload.parse(event.payload) };
  },
  "link.onError": (def, _state, event) => {
    const link = nameOf(event);
    required(def.links?.[link]?.onError, `link "${link}" onError`);
    return { type: "link.onError", link, ...LinkErrorPayload.parse(event.payload) };
  },
  timer: (def, state, event) => {
    const name = nameOf(event);
    required(findTimer(def, phaseOf(def, state), name), `timer "${name}"`);
    return { type: "timer", name, ...TimerPayload.parse(event.payload) };
  },
  migrate: (def, state, event) => {
    required(def.migrate, "migrate");
    const persisted = def.serialize ? def.serialize(state) : state;
    return { type: "migrate", ...MigratePayload.parse(event.payload), persisted };
  },
};

/** One event replayed through the step core: the next state and the timer schedules/cancels it made. */
async function replayEvent(
  def: ReplayableDef,
  state: unknown,
  event: JournalEvent,
  options: FoldOptions,
): Promise<{ state: unknown; timerOps: TimerOp[]; emitted: readonly EmittedEvent[] }> {
  const env = options.env ?? {};
  const facts = replayStepFacts(event.facts, options.guard, event.seq);
  if (event.causeType === "init") {
    required(def.init, "init");
    const io = { env, link: async (name: string, id: string) => facts.takeLinkView(name, id) };
    const cause = { input: event.payload, caller: event.caller, callerType: event.callerType };
    return { state: (await stepInit(def, cause, facts, io)).state, timerOps: [], emitted: [] };
  }
  if (event.causeType === "restore") {
    throw new ActorKitError(
      "journal_invalid",
      "Journal replay: a restore event replays only within its journal (use foldJournal)",
    );
  }
  const result = step(def, state, REPLAY_CAUSES[event.causeType](def, state, event), facts, env);
  return {
    state: result.state,
    timerOps: result.effects.toTimerOps(event.seq),
    emitted: result.event.emitted ?? [],
  };
}

/** Fold one journal event through the definition's current handlers (the step core, guards never run). */
export async function applyJournalEvent(
  def: ReplayableDef,
  state: unknown,
  event: JournalEvent,
  options: { env?: unknown } = {},
): Promise<unknown> {
  return (await replayEvent(def, state, event, options)).state;
}

/** Thrown when a replayed state's checksum differs from the one recorded when the event was written. */
export class JournalDivergenceError extends ActorKitError {
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
      "journal_divergence",
      `Journal replay diverged at seq ${seq} (${causeType}${causeName === null ? "" : ` ${causeName}`}): expected checksum ${expected}, got ${actual}`,
    );
  }
}

/** Thrown when replay emits different domain events than the journal recorded (ADR-017 §2). */
export class JournalEmittedDivergenceError extends ActorKitError {
  override name = "JournalEmittedDivergenceError";
  constructor(
    readonly seq: number,
    readonly causeType: string,
    /** Position of the first differing event in the transition's emitted list. */
    readonly index: number,
    readonly expected: EmittedEvent | undefined,
    readonly actual: EmittedEvent | undefined,
  ) {
    super(
      "journal_emitted_divergence",
      `Journal replay emitted different events at seq ${seq} (${causeType}), event ${index}: expected ${describeEmitted(expected)}, got ${describeEmitted(actual)}`,
    );
  }
}

function describeEmitted(event: EmittedEvent | undefined): string {
  return event === undefined ? "nothing" : `${event.name} ${JSON.stringify(event.payload)}`;
}

/** The first position where two emitted lists differ (by name and JSON payload), or -1. */
function firstEmittedDifference(expected: readonly EmittedEvent[], actual: readonly EmittedEvent[]): number {
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    if (describeEmitted(expected[i]) !== describeEmitted(actual[i])) return i;
  }
  return -1;
}

function verifyEmitted(event: JournalEvent, actual: readonly EmittedEvent[]): void {
  const expected = event.emitted ?? [];
  const index = firstEmittedDifference(expected, actual);
  if (index !== -1) {
    throw new JournalEmittedDivergenceError(event.seq, event.causeType, index, expected[index], actual[index]);
  }
}

// --- Folding: state and pending timers, seq by seq ---

/** A pending timer as a fold tracks it (the timers table row, payload parsed). */
export interface ScheduledTimer {
  readonly id: string;
  readonly seq: number;
  readonly index: number;
  readonly name: string;
  readonly key: string;
  readonly payload: unknown;
  readonly fireAt: number;
}

/** The actor at one seq: its state and its pending timers. */
export interface FoldPoint {
  readonly state: unknown;
  readonly timers: readonly ScheduledTimer[];
}

const ScheduledTimerSchema = z.object({
  id: z.string(),
  seq: z.number(),
  index: z.number(),
  name: z.string(),
  key: z.string(),
  payload: z.unknown(),
  fireAt: z.number(),
});
const ScheduledTimersSchema = z.array(ScheduledTimerSchema);
const RestorePayload = z.object({ toSeq: z.number().int() });
const FiredTimerPayload = z.object({ id: z.string() });

/** Apply schedules and cancels in order (a key is unique: scheduling it again replaces it), keep deadline order. */
export function applyScheduleOps(timers: readonly ScheduledTimer[], ops: readonly TimerOp[]): ScheduledTimer[] {
  let next = [...timers];
  for (const op of ops) {
    next = next.filter((t) => t.key !== op.key);
    if (op.op === "schedule") {
      next.push({
        id: op.id,
        seq: op.seq,
        index: op.index,
        name: op.name,
        key: op.key,
        payload: op.payload,
        fireAt: op.fireAt,
      });
    }
  }
  return next.sort((a, b) => a.fireAt - b.fireAt || a.seq - b.seq || a.index - b.index);
}

/** The pending timers stored with a checkpoint (none for checkpoints written before ADR-015). */
function checkpointTimers(checkpoint: JournalCheckpoint): ScheduledTimer[] {
  return ScheduledTimersSchema.parse(JSON.parse(checkpoint.timers ?? "[]"));
}

/** The checkpoint's state, after checking its checksum. */
export function checkpointPoint(def: ReplayableDef, checkpoint: JournalCheckpoint): FoldPoint {
  const actual = xxh64(checkpoint.state);
  if (actual !== checkpoint.checksum) {
    throw new JournalDivergenceError(checkpoint.seq, "checkpoint", null, checkpoint.checksum, actual);
  }
  const parsed: unknown = JSON.parse(checkpoint.state);
  return { state: def.restore ? def.restore(parsed) : parsed, timers: checkpointTimers(checkpoint) };
}

/**
 * Fold events (contiguous, after `start.seq`) from `start`, verifying every after-state checksum.
 * A `restore` event goes back to the point at its toSeq, which must be `start` or folded here.
 * Returns the point after each event.
 */
export async function foldEvents(
  def: ReplayableDef,
  start: { seq: number; point: FoldPoint },
  events: readonly JournalEvent[],
  options: FoldOptions = {},
): Promise<Map<number, FoldPoint>> {
  return (await foldToEnd(def, start, events, options)).points;
}

/** foldEvents, plus the point after the last event (`start.point` when there are none). */
async function foldToEnd(
  def: ReplayableDef,
  start: { seq: number; point: FoldPoint },
  events: readonly JournalEvent[],
  options: FoldOptions,
): Promise<{ points: Map<number, FoldPoint>; end: FoldPoint }> {
  const points = new Map<number, FoldPoint>([[start.seq, start.point]]);
  let point = start.point;
  let expectedSeq = start.seq + 1;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      throw new ActorKitError("journal_invalid", `Journal replay: expected seq ${expectedSeq}, found ${event.seq}`);
    }
    const folded = await foldEventEmitting(def, point, event, points, options);
    point = folded.point;
    if (options.rebuild !== true) {
      verifyChecksum(def, point, event);
      verifyEmitted(event, folded.emitted);
    }
    points.set(event.seq, point);
    expectedSeq += 1;
  }
  return { points, end: point };
}

export interface FoldOptions {
  readonly env?: unknown;
  /**
   * Rebuild by replay (ADR-015 D5): run every event under the current handlers, upcasting payloads
   * journaled by older versions, skipping version bumps, and without comparing checksums.
   */
  readonly rebuild?: boolean;
  /** Runs every handler (ADR-016 §5): replayJournal() passes withDeterminismGuard. */
  readonly guard?: <T>(handler: () => T) => T;
}

function verifyChecksum(def: ReplayableDef, point: FoldPoint, event: JournalEvent): void {
  const actual = checksumState(def, point.state);
  if (actual !== event.stateChecksum) {
    throw new JournalDivergenceError(event.seq, event.causeType, event.name, event.stateChecksum, actual);
  }
}

/** An event as a rebuild replays it: payload upcast from the version that wrote it. */
function upcastEvent(def: ReplayableDef, event: JournalEvent): JournalEvent {
  if (event.causeType !== "message" || def.upcast === undefined || event.name === null) return event;
  return { ...event, payload: def.upcast(event.name, event.payload, event.codeVersion) };
}

/**
 * One event folded onto `point` (the state and pending timers before it). A `restore` event goes
 * back to the point at its toSeq, which `points` must hold. Throws when the event does not replay.
 */
export async function foldEvent(
  def: ReplayableDef,
  point: FoldPoint,
  event: JournalEvent,
  points: ReadonlyMap<number, FoldPoint>,
  options: FoldOptions,
): Promise<FoldPoint> {
  return (await foldEventEmitting(def, point, event, points, options)).point;
}

/** foldEvent, plus the domain events the replayed transition emitted. */
async function foldEventEmitting(
  def: ReplayableDef,
  point: FoldPoint,
  event: JournalEvent,
  points: ReadonlyMap<number, FoldPoint>,
  options: FoldOptions,
): Promise<{ point: FoldPoint; emitted: readonly EmittedEvent[] }> {
  if (options.rebuild === true) {
    if (event.causeType === "migrate") return { point, emitted: [] };
    return foldEventEmitting(def, point, upcastEvent(def, event), points, { ...options, rebuild: false });
  }
  if (event.causeType === "restore") {
    const { toSeq } = RestorePayload.parse(event.payload);
    const target = points.get(toSeq);
    if (target === undefined) {
      throw new ActorKitError(
        "journal_invalid",
        `Journal replay: event ${event.seq} restores to seq ${toSeq}, which this journal does not cover`,
      );
    }
    return { point: target, emitted: [] };
  }
  const replayed = await replayEvent(def, point.state, event, options);
  const remaining =
    event.causeType === "timer"
      ? point.timers.filter((t) => t.id !== FiredTimerPayload.parse(event.payload).id)
      : point.timers;
  return {
    point: { state: replayed.state, timers: applyScheduleOps(remaining, replayed.timerOps) },
    emitted: replayed.emitted,
  };
}

/** Thrown when a journal event was written by a version with no path to the current one. */
export class JournalVersionError extends ActorKitError {
  override name = "JournalVersionError";
  constructor(
    readonly seq: number,
    readonly codeVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      "journal_version",
      `Journal replay: event ${seq} was written by version ${codeVersion}, which has no path to version ${currentVersion}`,
    );
  }
}

/** Every event must come from a version in the chain, not newer than the current one. */
function checkVersions(def: ReplayableDef, events: readonly JournalEvent[]): void {
  const { knownVersions, version } = def;
  if (knownVersions === undefined || version === undefined) return;
  for (const event of events) {
    if (!knownVersions.includes(event.codeVersion) || event.codeVersion > version) {
      throw new JournalVersionError(event.seq, event.codeVersion, version);
    }
  }
}

/** The actor before init: no state, no timers. */
function beforeInit(): FoldPoint {
  return { state: undefined, timers: [] };
}

/** Where a journal can be folded from: init (seq 0) or the checkpoint just before its first event. */
function journalStart(def: ReplayableDef, journal: Journal, first: JournalEvent): { seq: number; point: FoldPoint } {
  if (first.causeType === "init") return { seq: first.seq - 1, point: beforeInit() };
  return checkpointStart(def, journal, first.seq - 1, `no checkpoint at seq ${first.seq - 1} to start from`);
}

function checkpointStart(def: ReplayableDef, journal: Journal, seq: number, missing: string) {
  const checkpoint = journal.checkpoints.find((c) => c.seq === seq);
  if (checkpoint === undefined) throw new ActorKitError("journal_invalid", `Journal replay: ${missing}`);
  return { seq, point: checkpointPoint(def, checkpoint) };
}

/**
 * The events a journal's current code can replay: all of them, or, when older versions wrote
 * some, those after the last version bump (from the checkpoint written with it).
 */
function replayable(
  def: ReplayableDef,
  journal: Journal,
  events: [JournalEvent, ...JournalEvent[]],
): { start: { seq: number; point: FoldPoint }; events: JournalEvent[] } {
  const current = def.version;
  if (current === undefined || events.every((e) => e.codeVersion >= current)) {
    return { start: journalStart(def, journal, events[0]), events };
  }
  const bump = events.filter((e) => e.causeType === "migrate").at(-1)?.seq ?? 0;
  const start = checkpointStart(def, journal, bump, `no checkpoint at the version bump (seq ${bump})`);
  return { start, events: events.filter((e) => e.seq > bump) };
}

/**
 * Rebuild by replay (ADR-015 D5): the state the current handlers make of the whole journal, from
 * init, with older payloads upcast. Checksums are not compared: older events were written by
 * other code.
 */
export async function rebuildFromJournal(
  def: ReplayableDef,
  journal: Journal,
  options: { env?: unknown } = {},
): Promise<unknown> {
  const events = [...journal.events].sort((a, b) => a.seq - b.seq);
  const first = events[0];
  if (first?.causeType !== "init") {
    throw new ActorKitError(
      "journal_invalid",
      `Rebuilding by replay needs the whole journal: it starts at seq ${first?.seq ?? 0}`,
    );
  }
  const { end } = await foldToEnd(def, { seq: 0, point: beforeInit() }, events, { ...options, rebuild: true });
  return end.state;
}

/**
 * Replay a journal from init (or, for a pruned journal, from the checkpoint just before its
 * first event), verifying every event's after-state checksum. Throws on the first divergence.
 */
export async function foldJournal(
  def: ReplayableDef,
  journal: Journal,
  options: Pick<FoldOptions, "env" | "guard"> = {},
): Promise<{ state: unknown; replayed: number }> {
  const [first, ...rest] = [...journal.events].sort((a, b) => a.seq - b.seq);
  if (first === undefined) return { state: undefined, replayed: 0 };
  const sorted: [JournalEvent, ...JournalEvent[]] = [first, ...rest];
  checkVersions(def, sorted);
  const { start, events } = replayable(def, journal, sorted);
  const { end } = await foldToEnd(def, start, events, options);
  return { state: end.state, replayed: events.length };
}
