/**
 * Studio protocol — pure parsing and request handling for the actor-side
 * studio entry points (`__getTimeline`, timeline rows, studio WebSocket frames).
 *
 * Everything that crosses the studio boundary (RPC options, SQLite rows,
 * WebSocket frames) is parsed here with Zod. Invalid data is rejected with
 * a descriptive error, never coerced.
 */

import { z } from "zod";
import { type RolePredicate, resolveRole } from "./roles";

// --- Config ---

export const DEFAULT_TIMELINE_SIZE = 500;

/** Validate `studio.timelineSize` at definition time. A size < 1 would drop or never prune entries. */
export function resolveTimelineSize(size: number | undefined): number {
  if (size === undefined) return DEFAULT_TIMELINE_SIZE;
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`studio.timelineSize must be a positive integer, got ${String(size)}`);
  }
  return size;
}

// --- Timeline ---

export const DEFAULT_TIMELINE_LIMIT = 50;

const TimelineOptionsSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    before: z.number().int().positive().optional(),
  })
  .optional();

export interface TimelineQuery {
  limit: number;
  before: number | undefined;
}

/** Parse `__getTimeline` options. Throws `Invalid timeline options: …` on bad input. */
export function parseTimelineOptions(opts: unknown): TimelineQuery {
  const parsed = TimelineOptionsSchema.safeParse(opts);
  if (!parsed.success) {
    throw new Error(`Invalid timeline options: ${parsed.error.message}`);
  }
  return { limit: parsed.data?.limit ?? DEFAULT_TIMELINE_LIMIT, before: parsed.data?.before };
}

const TimelineRowSchema = z.object({
  id: z.number(),
  cause_type: z.string(),
  cause_data: z.string(),
  state_snapshot: z.string(),
  checksum: z.string(),
  created_at: z.number(),
});

export interface StudioTimelineEntry {
  id: number;
  causeType: string;
  causeData: string;
  stateSnapshot: string;
  checksum: string;
  createdAt: number;
}

/** Parse a `timeline` SQLite row into the wire shape shared by __getTimeline, the snapshot and live pushes. */
export function toTimelineEntry(raw: unknown): StudioTimelineEntry {
  const row = TimelineRowSchema.parse(raw);
  return {
    id: row.id,
    causeType: row.cause_type,
    causeData: row.cause_data,
    stateSnapshot: row.state_snapshot,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

// --- Studio WebSocket frames ---

const StudioFrameSchema = z.object({ type: z.string() });

const RequestViewSchema = z.object({
  type: z.literal("studio.requestView"),
  role: z.string(),
  caller: z.string().optional(),
  callerType: z.enum(["user", "service"]).optional(),
});

export interface StudioViewSource<TState> {
  views: Record<string, { kind?: "shared" | "perCaller"; fn(state: TState, caller: string): unknown }>;
  roles: Record<string, RolePredicate<TState>>;
  state: TState;
}

export type StudioReply =
  | { type: "studio.error"; error: string }
  | { type: "studio.view"; role: string; caller: string | null; error: string }
  | { type: "studio.view"; role: string; caller: string | null; callerRole: string | null; data: unknown };

/**
 * Handle one frame sent by a studio WebSocket and return the reply to send back.
 * Studio sockets may only send studio.* requests — app messages are refused.
 */
export function handleStudioFrame<TState>(data: string, source: StudioViewSource<TState>): StudioReply {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { type: "studio.error", error: "Invalid JSON in studio frame" };
  }

  const frame = StudioFrameSchema.safeParse(json);
  if (!frame.success) {
    return { type: "studio.error", error: "Studio frames must be JSON objects with a string 'type'" };
  }

  if (frame.data.type !== "studio.requestView") {
    return {
      type: "studio.error",
      error: `Unsupported studio frame "${frame.data.type}": studio connections cannot send app messages`,
    };
  }

  const request = RequestViewSchema.safeParse(json);
  if (!request.success) {
    return { type: "studio.error", error: `Invalid studio.requestView: ${request.error.message}` };
  }
  return requestView(request.data, source);
}

function requestView<TState>(
  request: z.infer<typeof RequestViewSchema>,
  { views, roles, state }: StudioViewSource<TState>,
): StudioReply {
  const { role } = request;
  const caller = request.caller ?? null;

  // Own properties only: "__proto__", "constructor" etc. are not roles.
  const viewDef = Object.hasOwn(views, role) ? views[role] : undefined;
  if (viewDef === undefined) {
    return { type: "studio.view", role, caller, error: `No view for role "${role}"` };
  }

  // Legacy views without `kind` are treated as perCaller (matches the runtime).
  if (viewDef.kind !== "shared" && caller === null) {
    return { type: "studio.view", role, caller, error: `View for role "${role}" is perCaller: caller is required` };
  }

  let data: unknown;
  try {
    data = viewDef.fn(state, caller ?? "__studio");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "studio.view", role, caller, error: `View projection threw: ${message}` };
  }

  // Report the caller's actual role so the UI can flag a projection the caller would never receive.
  const callerRole =
    caller === null ? null : resolveRole(roles, state, caller, { callerType: request.callerType ?? "user" });

  return { type: "studio.view", role, caller, callerRole, data };
}
