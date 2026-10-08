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

// --- Viewer (ADR-014) ---

/** Who is looking. Agents get hashed callers. Omitted = human (the middleware only sets "agent"). */
export type StudioViewer = "human" | "agent";

const ViewerSchema = z.enum(["human", "agent"]).optional();

/** Header the studio middleware stamps on studio WebSocket upgrades. */
export const STUDIO_VIEWER_HEADER = "X-Actor-Kit-Studio-Viewer";
const STUDIO_VIEWER_TAG = "studioViewer:agent";

/** Viewer from the stamped header. Anything but "agent" (including absent) is a human. */
export function viewerFromHeader(value: string | null): StudioViewer {
  return value === "agent" ? "agent" : "human";
}

/** Socket tags recording the viewer, so it survives hibernation. */
export function viewerTags(viewer: StudioViewer): string[] {
  return viewer === "agent" ? [STUDIO_VIEWER_TAG] : [];
}

export function viewerFromTags(tags: readonly string[]): StudioViewer {
  return tags.includes(STUDIO_VIEWER_TAG) ? "agent" : "human";
}

const InspectOptionsSchema = z.object({ viewer: ViewerSchema }).strict().optional();

/** Parse `__inspect` options. Throws `Invalid inspect options: …` on bad input. */
export function parseInspectOptions(opts: unknown): { viewer: StudioViewer } {
  const parsed = InspectOptionsSchema.safeParse(opts);
  if (!parsed.success) {
    throw new Error(`Invalid inspect options: ${parsed.error.message}`);
  }
  return { viewer: parsed.data?.viewer ?? "human" };
}

// --- Timeline ---

export const DEFAULT_TIMELINE_LIMIT = 50;

const TimelineOptionsSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    before: z.number().int().positive().optional(),
    viewer: ViewerSchema,
  })
  .optional();

export interface TimelineQuery {
  limit: number;
  before: number | undefined;
  /** Absent = human. */
  viewer: StudioViewer | undefined;
}

/** Parse `__getTimeline` options. Throws `Invalid timeline options: …` on bad input. */
export function parseTimelineOptions(opts: unknown): TimelineQuery {
  const parsed = TimelineOptionsSchema.safeParse(opts);
  if (!parsed.success) {
    throw new Error(`Invalid timeline options: ${parsed.error.message}`);
  }
  return {
    limit: parsed.data?.limit ?? DEFAULT_TIMELINE_LIMIT,
    before: parsed.data?.before,
    viewer: parsed.data?.viewer,
  };
}

const TimelineRowSchema = z.object({
  id: z.number(),
  cause_type: z.string(),
  cause_data: z.string(),
  state_snapshot: z.string(),
  checksum: z.string(),
  created_at: z.number(),
  seq: z.number().nullable().optional(),
});

export interface StudioTimelineEntry {
  id: number;
  causeType: string;
  causeData: string;
  stateSnapshot: string;
  checksum: string;
  createdAt: number;
  /** The journal seq this entry recorded (ADR-015 D3: "restore to here"). Absent for older rows. */
  seq?: number;
}

/** Parse a `timeline` SQLite row into the wire shape shared by __getTimeline, the snapshot and live pushes. */
export function toTimelineEntry(raw: unknown): StudioTimelineEntry {
  const row = TimelineRowSchema.parse(raw);
  const entry = {
    id: row.id,
    causeType: row.cause_type,
    causeData: row.cause_data,
    stateSnapshot: row.state_snapshot,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
  return typeof row.seq === "number" ? { ...entry, seq: row.seq } : entry;
}

// --- Outbox and links (shared by __inspect, the snapshot and live pushes) ---

const OutboxRowSchema = z.object({
  id: z.string(),
  service: z.string(),
  payload: z.string(),
  status: z.string(),
  attempts: z.number(),
  created_at: z.number(),
});

export interface StudioOutboxEntry {
  id: string;
  service: string;
  payload: string;
  status: string;
  attempts: number;
  createdAt: number;
}

/** Parse an `executions` SQLite row into the studio wire shape. */
export function toOutboxEntry(raw: unknown): StudioOutboxEntry {
  const row = OutboxRowSchema.parse(raw);
  return {
    id: row.id,
    service: row.service,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

const ActiveLinkRowSchema = z.object({
  target_type: z.string(),
  target_id: z.string(),
  link_name: z.string(),
  version: z.number(),
});

export interface StudioActiveLink {
  targetType: string;
  targetId: string;
  linkName: string;
  version: number;
}

/** Parse an `active_links` SQLite row into the studio wire shape. */
export function toActiveLink(raw: unknown): StudioActiveLink {
  const row = ActiveLinkRowSchema.parse(raw);
  return { targetType: row.target_type, targetId: row.target_id, linkName: row.link_name, version: row.version };
}

const LinkSubscriberRowSchema = z.object({ subscriber_type: z.string(), subscriber_id: z.string() });

export interface StudioLinkSubscriber {
  subscriberType: string;
  subscriberId: string;
}

/** Parse a `link_subscribers` SQLite row into the studio wire shape. */
export function toLinkSubscriber(raw: unknown): StudioLinkSubscriber {
  const row = LinkSubscriberRowSchema.parse(raw);
  return { subscriberType: row.subscriber_type, subscriberId: row.subscriber_id };
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

const ViewOptionsSchema = z.object({
  role: z.string().min(1),
  caller: z.string().min(1).optional(),
  callerType: z.enum(["user", "service"]).optional(),
  viewer: ViewerSchema,
});

export type ViewOptions = z.infer<typeof ViewOptionsSchema>;

/** Parse `__getView` options. Throws `Invalid view options: …` on bad input. */
export function parseViewOptions(opts: unknown): ViewOptions & { viewer: StudioViewer } {
  const parsed = ViewOptionsSchema.safeParse(opts);
  if (!parsed.success) {
    throw new Error(`Invalid view options: ${parsed.error.message}`);
  }
  return { ...parsed.data, viewer: parsed.data.viewer ?? "human" };
}

export type StudioViewReply = Extract<StudioReply, { type: "studio.view" }>;

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
  return studioView(request.data, source);
}

/** Project one role's view for Studio (shared by the WS studio.requestView frame and __getView). */
export function studioView<TState>(
  request: { role: string; caller?: string | undefined; callerType?: "user" | "service" | undefined },
  { views, roles, state }: StudioViewSource<TState>,
): StudioViewReply {
  const { role } = request;
  const caller = request.caller ?? null;
  const projected = projectView(views, state, role, caller);
  if (!projected.ok) return { type: "studio.view", role, caller, error: projected.error };

  // Report the caller's actual role so the UI can flag a projection the caller would never receive.
  const callerRole =
    caller === null ? null : resolveRole(roles, state, caller, { callerType: request.callerType ?? "user" });

  return { type: "studio.view", role, caller, callerRole, data: projected.data };
}

type Projected = { ok: true; data: unknown } | { ok: false; error: string };

function projectView<TState>(
  views: StudioViewSource<TState>["views"],
  state: TState,
  role: string,
  caller: string | null,
): Projected {
  // Own properties only: "__proto__", "constructor" etc. are not roles.
  const viewDef = Object.hasOwn(views, role) ? views[role] : undefined;
  if (viewDef === undefined) return { ok: false, error: `No view for role "${role}"` };

  // Legacy views without `kind` are treated as perCaller (matches the runtime).
  if (viewDef.kind !== "shared" && caller === null) {
    return { ok: false, error: `View for role "${role}" is perCaller: caller is required` };
  }

  try {
    return { ok: true, data: viewDef.fn(state, caller ?? "__studio") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `View projection threw: ${message}` };
  }
}
