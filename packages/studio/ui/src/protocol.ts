/**
 * Studio wire formats, parsed at the boundary.
 *
 * Every payload the UI receives (HTTP JSON bodies and WebSocket frames) goes
 * through these schemas before it reaches React state. Timeline entries carry
 * their cause and state as JSON strings on the wire; they are parsed here,
 * once, into plain values so components never call JSON.parse.
 */
import { z } from "zod";

/** A string holding JSON text, parsed into an unknown value. */
const JsonText = z.string().transform((text, ctx): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON text" });
    return z.NEVER;
  }
});

const CauseRecord = z.record(z.string(), z.unknown());

export const ActorEntrySchema = z.object({
  actorType: z.string(),
  actorId: z.string(),
  lastActiveAt: z.number(),
  version: z.number().nullable(),
  connectionCount: z.number(),
});
export type ActorEntry = z.infer<typeof ActorEntrySchema>;

export const ConnectionSchema = z.object({
  /** Unique per app socket: two tabs of one caller are two connections. */
  connectionId: z.string().min(1),
  caller: z.string(),
  callerType: z.enum(["user", "service"]),
  connectedAt: z.number(),
  role: z.string().nullable(),
});
export type StudioConnectionInfo = z.infer<typeof ConnectionSchema>;

const OutboxEntrySchema = z.object({
  /** Effect id, `seq:index` (ADR-015 D1). */
  id: z.string(),
  service: z.string(),
  payload: z.string(),
  /** pending, running, retrying, done or failed (failed rows are dead letters). */
  status: z.string(),
  attempts: z.number(),
  createdAt: z.number(),
  /** When a `retrying` row tries next. Absent from actors older than ADR-015. */
  nextAttemptAt: z.number().nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

const ActiveLinkSchema = z.object({
  targetType: z.string(),
  targetId: z.string(),
  linkName: z.string(),
  version: z.number(),
});

const LinkSubscriberSchema = z.object({
  subscriberType: z.string(),
  subscriberId: z.string(),
});

export const InspectSchema = z.object({
  state: z.unknown(),
  version: z.number(),
  actorId: z.string().nullable(),
  connections: z.array(ConnectionSchema),
  outbox: z.array(OutboxEntrySchema),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});
export type InspectResult = z.infer<typeof InspectSchema>;

/** Wire entry → domain entry with cause and state already parsed. */
export const TimelineEntrySchema = z
  .object({
    id: z.number().int(),
    causeType: z.string(),
    causeData: JsonText.pipe(CauseRecord),
    stateSnapshot: JsonText,
    checksum: z.string(),
    createdAt: z.number(),
  })
  .transform((entry) => ({
    id: entry.id,
    causeType: entry.causeType,
    cause: entry.causeData,
    state: entry.stateSnapshot,
    checksum: entry.checksum,
    createdAt: entry.createdAt,
  }));
export type TimelineItem = z.infer<typeof TimelineEntrySchema>;

export const ActorsResponseSchema = z.object({ actors: z.array(ActorEntrySchema) });
export const ActorTypesResponseSchema = z.object({ types: z.array(z.string()) });
export const TimelineResponseSchema = z.object({
  entries: z.array(TimelineEntrySchema),
  hasMore: z.boolean(),
});
export const ErrorBodySchema = z.object({ error: z.string() });

/** A Studio action the actor accepted (refusals arrive as an error body). */
export const ActionOkSchema = z.object({ ok: z.literal(true) });

/** Actions an admin can take from Studio (POST .../actions, mutate scope). */
export type StudioAction = { action: "redrive"; effectId: string };

// --- WebSocket frames ---

const SnapshotFrameSchema = InspectSchema.extend({
  type: z.literal("studio.snapshot"),
  timeline: z.array(TimelineEntrySchema),
  actorType: z.string(),
  actorId: z.string(),
});

const TimelineFrameSchema = z.object({
  type: z.literal("studio.timeline"),
  entry: TimelineEntrySchema,
});

const ConnectionFrameSchema = z.discriminatedUnion("action", [
  z.object({
    type: z.literal("studio.connection"),
    action: z.literal("connect"),
    connection: ConnectionSchema,
  }),
  z.object({
    type: z.literal("studio.connection"),
    action: z.literal("disconnect"),
    connection: ConnectionSchema.pick({ connectionId: true, caller: true, callerType: true }),
  }),
]);

/** The whole outbox, pushed whenever an execution is added or settles. */
const OutboxFrameSchema = z.object({
  type: z.literal("studio.outbox"),
  outbox: z.array(OutboxEntrySchema),
});

/** Active links and subscribers, pushed whenever either changes. */
const LinksFrameSchema = z.object({
  type: z.literal("studio.links"),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});

const FrameSchema = z.union([
  SnapshotFrameSchema,
  TimelineFrameSchema,
  ConnectionFrameSchema,
  OutboxFrameSchema,
  LinksFrameSchema,
]);
export type StudioFrame = z.infer<typeof FrameSchema>;

/** Frame types the UI understands. Anything else (e.g. `studio.view`) is ignored. */
const KNOWN_FRAME_TYPES = new Set([
  "studio.snapshot",
  "studio.timeline",
  "studio.connection",
  "studio.outbox",
  "studio.links",
]);

const FrameEnvelopeSchema = z.object({ type: z.string() });

export type ParsedFrame =
  | { kind: "frame"; frame: StudioFrame }
  | { kind: "ignored"; type: string }
  | { kind: "malformed"; error: string };

/** Parse one raw WebSocket message. Never throws. */
export function parseStudioFrame(raw: unknown): ParsedFrame {
  if (typeof raw !== "string") {
    return { kind: "malformed", error: "Expected a text frame" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "malformed", error: "Frame is not valid JSON" };
  }
  const envelope = FrameEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return { kind: "malformed", error: "Frame has no type" };
  }
  if (!KNOWN_FRAME_TYPES.has(envelope.data.type)) {
    return { kind: "ignored", type: envelope.data.type };
  }
  const parsed = FrameSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: "malformed", error: `Invalid ${envelope.data.type} frame: ${formatIssues(parsed.error)}` };
  }
  return { kind: "frame", frame: parsed.data };
}

/** Short, human-readable summary of a Zod error (first issue with its path). */
export function formatIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return "invalid data";
  const path = first.path.map(String).join(".");
  return path === "" ? first.message : `${path}: ${first.message}`;
}
