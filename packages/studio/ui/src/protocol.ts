/**
 * Studio wire formats, parsed at the boundary.
 *
 * Every payload the UI receives (HTTP JSON bodies and WebSocket frames) goes
 * through these schemas before it reaches React state. Timeline entries carry
 * their cause and state as JSON strings on the wire; they are parsed here,
 * once, into plain values so components never call JSON.parse.
 */
import { z } from "zod";

/** JSON text parsed into an unknown value, or an "Invalid JSON text" issue. */
function parseJsonValue(text: string, ctx: z.RefinementCtx): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON text" });
    return z.NEVER;
  }
}

/** A string holding JSON text, parsed into an unknown value. */
const JsonText = z.string().transform(parseJsonValue);

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
  /** The last error's `_tag` (ADR-016 §2): Timeout, Defect or a declared error. Absent when untagged. */
  lastErrorTag: z.string().optional(),
  /** Forwards only (`service` is then the link); rows without it are executions. */
  kind: z.literal("forward").optional(),
  /** Forwards only: the target actor's id. */
  target: z.string().optional(),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

/** A pending durable timer (ADR-015 D2); its payload arrives as redacted JSON text. */
const TimerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  payload: JsonText,
  fireAt: z.number(),
  createdAt: z.number(),
});
export type TimerEntry = z.infer<typeof TimerEntrySchema>;

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
  /** Absent from actors older than ADR-015 and for actors that do not exist. */
  timers: z.array(TimerEntrySchema).optional(),
  /** Refused messages ever counted (ADR-018 F); absent from older actors. */
  rejections: z.object({ total: z.number(), byCode: z.record(z.string(), z.number()) }).optional(),
  /** Where the journal lives and the object's storage (ADR-019 D); absent without a journal. */
  journal: z
    .object({
      local: z.object({ from: z.number(), to: z.number(), events: z.number() }).nullable(),
      archived: z.array(z.object({ from: z.number(), to: z.number(), bytes: z.number() })),
      archivedBytes: z.number(),
      storageBytes: z.number(),
      capBytes: z.number(),
      nearCap: z.boolean(),
    })
    .optional(),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});
export type InspectResult = z.infer<typeof InspectSchema>;

/** The after-state: JSON text, or null when the journal could not rebuild it (ADR-017 §5). */
const StateSnapshot = z
  .string()
  .nullable()
  .transform((text, ctx): { known: boolean; value: unknown } =>
    text === null ? { known: false, value: null } : { known: true, value: parseJsonValue(text, ctx) },
  );

/** A timeline entry as the UI holds it: cause and state parsed. */
export interface TimelineItem {
  id: number;
  causeType: string;
  cause: Record<string, unknown>;
  /** The state after the entry (null and meaningless when `stateUnavailable`). */
  state: unknown;
  checksum: string;
  createdAt: number;
  seq: number | undefined;
  /** The flow the event belongs to (ADR-017 §4); absent or null for events written before ids. */
  correlationId: string | null | undefined;
  /** The event or effect that caused it (`type/id/seq[:index]`); null when it started its flow. */
  causationId: string | null | undefined;
  /** Domain events the transition emitted (ADR-017 §2); undefined when none or before ADR-017. */
  emitted: Array<{ name: string; payload: unknown }> | undefined;
  /** Set when the journal could not rebuild the after-state. */
  stateUnavailable?: true;
  /** A handler read the clock or randomness directly (ADR-018 E): replay cannot reproduce the entry. */
  nondeterministic?: true;
}

const NONDETERMINISTIC: { nondeterministic: true } = { nondeterministic: true };

/** Wire entry → domain entry with cause and state already parsed. */
export const TimelineEntrySchema = z
  .object({
    /** The journal seq of the event (ADR-017 §5: the timeline is the journal). */
    id: z.number().int(),
    causeType: z.string(),
    causeData: JsonText.pipe(CauseRecord),
    stateSnapshot: StateSnapshot,
    checksum: z.string(),
    createdAt: z.number(),
    /** The journal seq the entry recorded (ADR-015 D3). Absent from older rows. */
    seq: z.number().int().optional(),
    correlationId: z.string().nullable().optional(),
    causationId: z.string().nullable().optional(),
    emitted: JsonText.pipe(z.array(z.object({ name: z.string(), payload: z.unknown() })))
      .nullable()
      .optional(),
    nondeterministic: z.boolean().optional(),
  })
  .transform((entry): TimelineItem => {
    const item = {
      id: entry.id,
      causeType: entry.causeType,
      cause: entry.causeData,
      state: entry.stateSnapshot.value,
      checksum: entry.checksum,
      createdAt: entry.createdAt,
    };
    const withSeq = {
      ...item,
      seq: entry.seq,
      correlationId: entry.correlationId,
      causationId: entry.causationId,
      emitted: entry.emitted ?? undefined,
      ...(entry.nondeterministic === true ? NONDETERMINISTIC : {}),
    };
    return entry.stateSnapshot.known ? withSeq : { ...withSeq, stateUnavailable: true };
  });

export const ActorsResponseSchema = z.object({ actors: z.array(ActorEntrySchema) });
export const ActorTypesResponseSchema = z.object({ types: z.array(z.string()) });
export const TimelineResponseSchema = z.object({
  entries: z.array(TimelineEntrySchema),
  hasMore: z.boolean(),
});
export const ErrorBodySchema = z.object({ error: z.string() });

/** Actions an admin can take from Studio (POST .../actions, mutate scope). */
export type StudioAction =
  | { action: "redrive"; effectId: string }
  | { action: "fireTimer"; key: string }
  | { action: "restore"; toSeq: number };

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

/** The pending timers, pushed whenever one is scheduled, cancelled or fires. */
const TimersFrameSchema = z.object({
  type: z.literal("studio.timers"),
  timers: z.array(TimerEntrySchema),
});

/** Active links and subscribers, pushed whenever either changes. */
const LinksFrameSchema = z.object({
  type: z.literal("studio.links"),
  activeLinks: z.array(ActiveLinkSchema),
  linkSubscribers: z.array(LinkSubscriberSchema),
});

export type StudioFrame =
  | z.infer<typeof SnapshotFrameSchema>
  | z.infer<typeof TimelineFrameSchema>
  | z.infer<typeof ConnectionFrameSchema>
  | z.infer<typeof OutboxFrameSchema>
  | z.infer<typeof TimersFrameSchema>
  | z.infer<typeof LinksFrameSchema>;

/**
 * The schema for each frame type the UI understands. Anything else (e.g. `studio.view`)
 * is ignored. Parsing against the frame's own schema (not the union) keeps the failing
 * path in the error message.
 */
const FRAME_SCHEMAS = new Map<string, z.ZodType<StudioFrame>>([
  ["studio.snapshot", SnapshotFrameSchema],
  ["studio.timeline", TimelineFrameSchema],
  ["studio.connection", ConnectionFrameSchema],
  ["studio.outbox", OutboxFrameSchema],
  ["studio.timers", TimersFrameSchema],
  ["studio.links", LinksFrameSchema],
]);

const FrameEnvelopeSchema = z.object({ type: z.string() });

export type ParsedFrame =
  | { kind: "frame"; frame: StudioFrame }
  | { kind: "ignored"; type: string }
  | { kind: "malformed"; error: string };

function parseJsonText(raw: unknown): { ok: true; json: unknown } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Expected a text frame" };
  try {
    const json: unknown = JSON.parse(raw);
    return { ok: true, json };
  } catch {
    return { ok: false, error: "Frame is not valid JSON" };
  }
}

/** Parse one raw WebSocket message. Never throws. */
export function parseStudioFrame(raw: unknown): ParsedFrame {
  const text = parseJsonText(raw);
  if (!text.ok) return { kind: "malformed", error: text.error };
  const envelope = FrameEnvelopeSchema.safeParse(text.json);
  if (!envelope.success) return { kind: "malformed", error: "Frame has no type" };
  const { type } = envelope.data;
  const schema = FRAME_SCHEMAS.get(type);
  if (schema === undefined) return { kind: "ignored", type };
  const parsed = schema.safeParse(text.json);
  if (!parsed.success) return { kind: "malformed", error: `Invalid ${type} frame: ${formatIssues(parsed.error)}` };
  return { kind: "frame", frame: parsed.data };
}

/** Short, human-readable summary of a Zod error (first issue with its path). */
export function formatIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return "invalid data";
  const path = first.path.map(String).join(".");
  return path === "" ? first.message : `${path}: ${first.message}`;
}
