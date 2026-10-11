/**
 * Timeline shape: what an agent may copy into a public place (a GitHub issue).
 *
 * Keeps cause types, message/service names, roles, caller types, payload/input KEYS, changed
 * state paths (array indices generalised to `*`) and checksums. Drops every value, every
 * error message and every caller, even though the server already redacted and hashed them.
 *
 * Object keys are kept: an actor that keys records by a person's name exposes it here.
 * Key records by id.
 */

import { z } from "zod";
import type { JournalEntry, TimelineEntry } from "./client";
import { defined } from "./present";

export interface TimelineShapeEntry {
  id: number;
  at: number;
  causeType: string;
  messageType?: string;
  service?: string;
  role?: string;
  callerType?: string;
  payloadKeys?: string[];
  inputKeys?: string[];
  checksum: string;
  changedPaths: string[];
}

const CauseSchema = z.object({
  messageType: z.string().optional(),
  service: z.string().optional(),
  role: z.string().optional(),
  callerType: z.string().optional(),
  payload: z.unknown().optional(),
  input: z.unknown().optional(),
});

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(value: unknown): string[] | undefined {
  return isRecord(value) ? Object.keys(value).sort() : undefined;
}

/** Leaf paths that differ between two JSON values, array indices as `*`, sorted and deduped. */
export function changedPaths(before: unknown, after: unknown): string[] {
  const out = new Set<string>();
  const visit = (a: unknown, b: unknown, path: string[]): void => {
    for (const [childA, childB, segment] of children(a, b)) visit(childA, childB, [...path, segment]);
    if (isLeafPair(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out.add(path.length === 0 ? "$" : path.join("."));
  };
  visit(before, after, []);
  return [...out].sort();
}

/** Two arrays or two records are compared child by child; anything else is a leaf pair. */
function isLeafPair(a: unknown, b: unknown): boolean {
  return !(Array.isArray(a) && Array.isArray(b)) && !(isRecord(a) && isRecord(b));
}

/** Child pairs to compare under two arrays (index as `*`) or two records (every key of either). */
function children(a: unknown, b: unknown): [unknown, unknown, string][] {
  if (Array.isArray(a) && Array.isArray(b)) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i], "*"]);
  }
  if (isRecord(a) && isRecord(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].map((key) => [ownValue(a, key), ownValue(b, key), key]);
  }
  return [];
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

type CauseShape = Pick<
  TimelineShapeEntry,
  "messageType" | "service" | "role" | "callerType" | "payloadKeys" | "inputKeys"
>;

/** Names and keys from a cause, never its values. Unparsable cause data gives nothing. */
function causeShape(causeData: string): CauseShape {
  return causeFieldsShape(parseJson(causeData));
}

function causeFieldsShape(value: unknown): CauseShape {
  const cause = CauseSchema.safeParse(value);
  if (!cause.success) return {};
  const { messageType, service, role, callerType, payload, input } = cause.data;
  return defined({ messageType, service, role, callerType, payloadKeys: keysOf(payload), inputKeys: keysOf(input) });
}

/** Changed state paths since the previous entry; none without a predecessor or a parsable pair. */
function pathsSince(previous: TimelineEntry | undefined, entry: TimelineEntry): string[] {
  if (previous === undefined) return [];
  const before = parseJson(previous.stateSnapshot);
  const after = parseJson(entry.stateSnapshot);
  return before === undefined || after === undefined ? [] : changedPaths(before, after);
}

/** Shape of a timeline page, oldest first. The oldest entry has no predecessor, so no changed paths. */
export function timelineShape(entries: readonly TimelineEntry[]): TimelineShapeEntry[] {
  const ordered = [...entries].sort((a, b) => a.id - b.id);
  return ordered.map((entry, index) => ({
    id: entry.id,
    at: entry.createdAt,
    causeType: entry.causeType,
    checksum: entry.checksum,
    changedPaths: pathsSince(ordered[index - 1], entry),
    ...causeShape(entry.causeData),
  }));
}

export interface JournalShapeEntry extends CauseShape {
  seq: number;
  at: number;
  causeType: string;
  checksum: string;
  emitted: Array<{ name: string; published: boolean; payloadKeys?: string[] }>;
}

/** Shape of a journal page (ADR-019 F), oldest first: names, keys and published flags; no values, callers or ids. */
export function journalShape(entries: readonly JournalEntry[]): JournalShapeEntry[] {
  return [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => ({
      seq: entry.seq,
      at: entry.createdAt,
      causeType: entry.causeType,
      checksum: entry.checksum,
      emitted: entry.emitted.map((e) => ({
        name: e.name,
        published: e.published,
        ...defined({ payloadKeys: keysOf(e.payload) }),
      })),
      ...causeFieldsShape(entry.cause),
    }));
}
