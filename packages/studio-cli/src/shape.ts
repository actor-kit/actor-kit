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
import type { TimelineEntry } from "./client";

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

function parseJson(text: string): unknown {
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
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) visit(a[i], b[i], [...path, "*"]);
      return;
    }
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        visit(Object.hasOwn(a, key) ? a[key] : undefined, Object.hasOwn(b, key) ? b[key] : undefined, [...path, key]);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.add(path.length === 0 ? "$" : path.join("."));
  };
  visit(before, after, []);
  return [...out].sort();
}

/** Shape of a timeline page, oldest first. The oldest entry has no predecessor, so no changed paths. */
export function timelineShape(entries: readonly TimelineEntry[]): TimelineShapeEntry[] {
  const ordered = [...entries].sort((a, b) => a.id - b.id);
  return ordered.map((entry, index) => {
    const cause = CauseSchema.safeParse(parseJson(entry.causeData));
    const previous = ordered[index - 1];
    const shape: TimelineShapeEntry = { id: entry.id, at: entry.createdAt, causeType: entry.causeType, checksum: entry.checksum, changedPaths: [] };
    if (cause.success) {
      const { messageType, service, role, callerType, payload, input } = cause.data;
      if (messageType !== undefined) shape.messageType = messageType;
      if (service !== undefined) shape.service = service;
      if (role !== undefined) shape.role = role;
      if (callerType !== undefined) shape.callerType = callerType;
      const payloadKeys = keysOf(payload);
      if (payloadKeys !== undefined) shape.payloadKeys = payloadKeys;
      const inputKeys = keysOf(input);
      if (inputKeys !== undefined) shape.inputKeys = inputKeys;
    }
    if (previous !== undefined) {
      const before = parseJson(previous.stateSnapshot);
      const after = parseJson(entry.stateSnapshot);
      if (before !== undefined && after !== undefined) shape.changedPaths = changedPaths(before, after);
    }
    return shape;
  });
}
