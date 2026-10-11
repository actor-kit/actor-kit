/**
 * Rejections (ADR-018 F): a refused message leaves a trace outside the journal. Each refusal is a row in
 * `rejections` (code, message name, caller, role, payload hash, time; the newest 1000 are kept) and a
 * count per code in `rejection_counts` (never pruned), plus one structured log line. Rejections are not
 * transitions: nothing replays them, and the payload itself is never stored, only its hash.
 */

import { type RefusalCode, xxh64 } from "@actor-kit/core";
import { z } from "zod";
import type { JournalSql } from "./journal";

/** How many rejection rows an actor keeps (the counts are kept forever). */
export const REJECTIONS_KEEP = 1000;

export interface RejectionFields {
  readonly code: RefusalCode;
  readonly messageName: string;
  readonly caller: string;
  readonly callerType: "user" | "service";
  /** The caller's role; null when no role matched. */
  readonly role: string | null;
  readonly payload: unknown;
  readonly at: number;
}

/** The payload's fingerprint: equal payloads hash the same, and the payload is never stored. */
export function payloadHash(payload: unknown): string {
  return xxh64(JSON.stringify(payload ?? null));
}

/** Record one refusal: a row (oldest pruned past `keep`) and its code's count. */
export function recordRejection(sql: JournalSql, fields: RejectionFields, keep = REJECTIONS_KEEP): void {
  sql.exec(
    "INSERT INTO rejections (code, message_name, caller, caller_type, role, payload_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    fields.code,
    fields.messageName,
    fields.caller,
    fields.callerType,
    fields.role,
    payloadHash(fields.payload),
    fields.at,
  );
  sql.exec("DELETE FROM rejections WHERE id <= (SELECT MAX(id) FROM rejections) - ?", keep);
  sql.exec(
    "INSERT INTO rejection_counts (code, count) VALUES (?, 1) ON CONFLICT(code) DO UPDATE SET count = count + 1",
    fields.code,
  );
}

const CountRow = z.object({ code: z.string(), count: z.number() });

/** Refusals ever counted, in total and by code (Studio's counter). */
export function rejectionCounts(sql: JournalSql): { total: number; byCode: Record<string, number> } {
  const byCode: Record<string, number> = {};
  let total = 0;
  for (const raw of sql.exec("SELECT code, count FROM rejection_counts ORDER BY code").toArray()) {
    const row = CountRow.parse(raw);
    byCode[row.code] = row.count;
    total += row.count;
  }
  return { total, byCode };
}

const RejectionRow = z.object({
  code: z.string(),
  message_name: z.string(),
  caller: z.string(),
  caller_type: z.string(),
  role: z.string().nullable(),
  payload_hash: z.string(),
  at: z.number(),
});

export interface Rejection {
  readonly code: string;
  readonly messageName: string;
  readonly caller: string;
  readonly callerType: string;
  readonly role: string | null;
  readonly payloadHash: string;
  readonly at: number;
}

/** The newest rejections, newest first. */
export function readRejections(sql: JournalSql, limit: number): Rejection[] {
  return sql
    .exec(
      "SELECT code, message_name, caller, caller_type, role, payload_hash, at FROM rejections ORDER BY id DESC LIMIT ?",
      limit,
    )
    .toArray()
    .map((raw) => {
      const row = RejectionRow.parse(raw);
      return {
        code: row.code,
        messageName: row.message_name,
        caller: row.caller,
        callerType: row.caller_type,
        role: row.role,
        payloadHash: row.payload_hash,
        at: row.at,
      };
    });
}

export interface RejectionEvent {
  readonly event: "actor_kit.message.rejected";
  readonly actorType: string;
  readonly actorId: string;
  readonly code: RefusalCode;
  readonly message: string;
  readonly callerType: "user" | "service";
  readonly role: string | null;
  readonly payloadHash: string;
}

/** The structured line logged for a refusal. Stable fields first; no caller id and no payload. */
export function rejectionEvent(actorType: string, actorId: string, fields: RejectionFields): RejectionEvent {
  return {
    event: "actor_kit.message.rejected",
    actorType,
    actorId,
    code: fields.code,
    message: fields.messageName,
    callerType: fields.callerType,
    role: fields.role,
    payloadHash: payloadHash(fields.payload),
  };
}
