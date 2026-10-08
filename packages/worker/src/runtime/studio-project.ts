/**
 * Studio projections (ADR-014): what Studio may see of an actor.
 *
 * Every value leaving the DO for Studio passes through here: `studio.redact` patterns are applied
 * to state, cause data, outbox payloads and views, each relative to its own root; for agents,
 * callers are replaced with a keyed hash so they can be correlated but not read.
 */

import type { LiveConnection } from "./live-connections";
import type { OutboxRow } from "./outbox-store";
import type { StudioTimelineEntry } from "./studio-protocol";
import { REDACTED, type Redactor } from "./studio-redact";

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

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Redact a JSON-encoded value; an unparsable one is redacted whole when patterns are declared. */
function projectJson(text: string, projection: StudioProjection): string {
  if (!projection.redactor.active) return text;
  const parsed = parseJson(text);
  return JSON.stringify(parsed.ok ? projection.redactor.apply(parsed.value) : REDACTED);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function projectCause(text: string, projection: StudioProjection): Promise<string> {
  if (!projection.redactor.active && projection.hashCaller === null) return text;
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return projection.redactor.active ? JSON.stringify(REDACTED) : text;
  }
  const cause: Record<string, unknown> = { ...parsed.value };
  for (const field of VALUE_FIELDS) {
    if (Object.hasOwn(cause, field)) cause[field] = projection.redactor.apply(cause[field]);
  }
  const caller = cause["caller"];
  if (typeof caller === "string") cause["caller"] = await projectCaller(caller, projection);
  return JSON.stringify(cause);
}

export async function projectTimelineEntry(
  entry: StudioTimelineEntry,
  projection: StudioProjection,
): Promise<StudioTimelineEntry> {
  return {
    ...entry,
    causeData: await projectCause(entry.causeData, projection),
    stateSnapshot: projectJson(entry.stateSnapshot, projection),
  };
}

export type { OutboxRow as StudioOutboxRow } from "./outbox-store";

export function projectOutboxRow(row: OutboxRow, projection: StudioProjection): OutboxRow {
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
