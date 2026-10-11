/**
 * Studio projections (ADR-014): what Studio may see of an actor.
 *
 * Every value leaving the DO for Studio passes through here: `studio.redact` patterns are applied
 * to state, cause data, outbox payloads and views, each relative to its own root; for agents,
 * callers are replaced with a keyed hash so they can be correlated but not read.
 */

import type { JournalEntry } from "./journal-query";
import type { LiveConnection } from "./live-connections";
import type { OutboxRow } from "./outbox-store";
import { isBuiltInError } from "./service-error";
import type { StudioTimelineEntry } from "./studio-protocol";
import { REDACTED, type Redactor } from "./studio-redact";
import type { TimerRow } from "./timers-store";

export type CallerHasher = (caller: string) => Promise<string>;

export interface StudioProjection {
  redactor: Redactor;
  /** Set for agent viewers: callers are hashed. Null for people. */
  hashCaller: CallerHasher | null;
}

/** Cause fields that carry application values, each redacted relative to its own root. */
const VALUE_FIELDS = ["payload", "input", "result", "viewData"] as const;

/** HMAC-SHA256(key, caller), first 12 hex chars, memoized per hasher. */
export function createCallerHasher(key: string): CallerHasher {
  const memo = new Map<string, Promise<string>>();
  const encoder = new TextEncoder();
  const cryptoKey = crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return (caller) => {
    let hashed = memo.get(caller);
    if (hashed === undefined) {
      hashed = cryptoKey
        .then((k) => crypto.subtle.sign("HMAC", k, encoder.encode(caller)))
        .then((sig) => {
          const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
          return `caller:${hex.slice(0, 12)}`;
        });
      memo.set(caller, hashed);
    }
    return hashed;
  };
}

export function projectState(state: unknown, projection: StudioProjection): unknown {
  return projection.redactor.apply(state);
}

/** What parseJson returns for text that is not JSON (no JSON value is a symbol). */
const UNPARSABLE: unique symbol = Symbol();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return UNPARSABLE;
  }
}

/** Redact a JSON-encoded value; an unparsable one is redacted whole when patterns are declared. */
function projectJson(text: string, projection: StudioProjection): string {
  if (!projection.redactor.active) return text;
  const parsed = parseJson(text);
  return JSON.stringify(parsed === UNPARSABLE ? REDACTED : projection.redactor.apply(parsed));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function projectCause(text: string, projection: StudioProjection): Promise<string> {
  if (!projection.redactor.active && projection.hashCaller === null) return text;
  const parsed = parseJson(text);
  // UNPARSABLE is not a record either.
  if (!isRecord(parsed)) return projection.redactor.active ? JSON.stringify(REDACTED) : text;
  return JSON.stringify(await projectCauseFields(parsed, projection));
}

async function projectCauseFields(
  value: Record<string, unknown>,
  projection: StudioProjection,
): Promise<Record<string, unknown>> {
  const cause: Record<string, unknown> = { ...value };
  for (const field of VALUE_FIELDS) {
    if (Object.hasOwn(cause, field)) cause[field] = projection.redactor.apply(cause[field]);
  }
  const caller = cause["caller"];
  if (typeof caller === "string") cause["caller"] = await projectCaller(caller, projection);
  return cause;
}

export async function projectTimelineEntry(
  entry: StudioTimelineEntry,
  projection: StudioProjection,
): Promise<StudioTimelineEntry> {
  return {
    ...entry,
    causeData: await projectCause(entry.causeData, projection),
    stateSnapshot: entry.stateSnapshot === null ? null : projectJson(entry.stateSnapshot, projection),
    emitted: entry.emitted === null ? null : projectEmitted(entry.emitted, projection),
  };
}

/** A journal query entry (ADR-019 F): its cause like a timeline cause, each emitted payload from its own root. */
export async function projectJournalEntry(entry: JournalEntry, projection: StudioProjection): Promise<JournalEntry> {
  return {
    ...entry,
    cause: await projectCauseFields(entry.cause, projection),
    emitted: entry.emitted.map((event) => ({ ...event, payload: projection.redactor.apply(event.payload) })),
  };
}

/** Emitted events: each payload is redacted relative to its own root, like a message payload. */
function projectEmitted(text: string, projection: StudioProjection): string {
  if (!projection.redactor.active) return text;
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) return JSON.stringify(REDACTED);
  return JSON.stringify(
    parsed.map((event: unknown) => (isRecord(event) ? redactPayload(event, projection) : REDACTED)),
  );
}

function redactPayload(event: Record<string, unknown>, projection: StudioProjection): Record<string, unknown> {
  return Object.hasOwn(event, "payload") ? { ...event, payload: projection.redactor.apply(event["payload"]) } : event;
}

export type { OutboxRow as StudioOutboxRow } from "./outbox-store";

export function projectOutboxRow(row: OutboxRow, projection: StudioProjection): OutboxRow {
  const projected = { ...row, payload: projectJson(row.payload, projection) };
  // A declared service error (ADR-016 §2) is stored as its JSON: an application value, redacted like one.
  if (row.lastError === null || row.lastErrorTag === undefined || isBuiltInErrorTag(row.lastErrorTag)) {
    return projected;
  }
  return { ...projected, lastError: projectJson(row.lastError, projection) };
}

function isBuiltInErrorTag(tag: string): boolean {
  return isBuiltInError({ _tag: tag });
}

/** A pending timer as Studio may see it: the payload is redacted like any application value. */
export function projectTimerRow(row: TimerRow, projection: StudioProjection): TimerRow {
  return { ...row, payload: projectJson(row.payload, projection) };
}

/** A caller as this viewer may see it: hashed for agents, raw for people. */
export async function projectCaller(caller: string, projection: StudioProjection): Promise<string> {
  return projection.hashCaller === null ? caller : await projection.hashCaller(caller);
}

export async function projectConnections(
  connections: readonly LiveConnection[],
  projection: StudioProjection,
): Promise<LiveConnection[]> {
  return await Promise.all(connections.map(async (c) => ({ ...c, caller: await projectCaller(c.caller, projection) })));
}

type ViewReply =
  | { type: "studio.view"; role: string; caller: string | null; error: string }
  | { type: "studio.view"; role: string; caller: string | null; callerRole: string | null; data: unknown };

export async function projectView<R extends ViewReply>(reply: R, projection: StudioProjection): Promise<R> {
  const caller = reply.caller === null ? null : await projectCaller(reply.caller, projection);
  if ("data" in reply) return { ...reply, caller, data: projection.redactor.apply(reply.data) };
  return { ...reply, caller };
}
