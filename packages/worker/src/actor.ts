/**
 * actor() — the single function that defines an actor and returns a DO class.
 *
 * Usage:
 *   export const Counter = actor<Env>("counter", { init, roles, messages, views });
 *
 * Returns a class that extends DurableObject with:
 * - spawn(input) — idempotent creation
 * - send(caller, callerType, event) — message routing
 * - getSnapshot(caller, callerType) — view computation
 * - fetch(request) — WebSocket upgrade handling
 */

import { DurableObject } from "cloudflare:workers";
import type {
  ContractMessages,
  DeterministicContext,
  FieldDescriptor,
  MutationCause,
  SchemaDefinition,
} from "@actor-kit/core";
import { createDeltaFrame, createSnapshotFrame, encode, encodeDelta, xxh64 } from "@actor-kit/core";
import { DOQB } from "workers-qb";
import { z } from "zod";
import type { LifecycleEvent } from "./define";
import { hasActorDefShape } from "./runtime/actor-def";
import {
  type AttemptResult,
  createInFlight,
  DEFAULT_TIMEOUT_MS,
  resolveTimeoutMs,
  runAttempt,
} from "./runtime/attempt";
import { closeCodeToSend } from "./runtime/close-code";
import { type ConnectRequest, parseConnectRequest } from "./runtime/connect-request";
import {
  type DeliveryInfo,
  DeliveryInfoSchema,
  deliveryInfo,
  type EffectInfo,
  effectInfo,
} from "./runtime/effect-info";
import { type EnvParser, envErrorMessage, envInvalidEvent, parseActorEnv } from "./runtime/env";
import {
  appendJournalEvent,
  clockedSources,
  createLiveFacts,
  foldJournal,
  type JournalDraft,
  type JournalEvent,
  type JournalOption,
  journalHighWater,
  nextTransitionSeq,
  readJournal,
  rebuildFromJournal,
  resolveJournalConfig,
} from "./runtime/journal";
import {
  isStudioSocket,
  type LiveConnection,
  nextConnectionSeq,
  readConnectionAttachment,
  type SocketRecord,
  toLiveConnections,
} from "./runtime/live-connections";
import { ACTOR_KIT_MIGRATIONS } from "./runtime/migrations";
import {
  cancelUndoneEffects,
  type DueForward,
  dueExecutions,
  dueForwards,
  finishAttempt,
  insertExecutions,
  insertForwards,
  isRunning,
  nextRetryAt,
  outboxFailedEvent,
  readOutboxRows,
  redriveExecution,
  requeueInterrupted,
  startAttempt,
} from "./runtime/outbox-store";
import { resolveNamespace } from "./runtime/resolve-namespace";
import { planRestore } from "./runtime/restore";
import {
  DEFAULT_RETRY_POLICY,
  linkRetryPolicies,
  linkRetryRules,
  type RetryPolicy,
  resolveRetryPolicy,
  resolveRetryRule,
  type SettledTry,
  settleTry,
  type TryOutcome,
} from "./runtime/retry";
import { resolveRole } from "./runtime/roles";
import {
  classifyFailure,
  describeRecordedError,
  describeServiceError,
  type ErrorsParser,
  isBuiltInError,
  type TaggedError,
} from "./runtime/service-error";
import { admitMessage, liveStepFacts, type StepCause, type StepResult, step, stepInit } from "./runtime/step";
import {
  type CallerHasher,
  createCallerHasher,
  projectCaller,
  projectConnections,
  projectOutboxRow,
  projectState,
  projectTimelineEntry,
  projectTimerRow,
  projectView,
  type StudioOutboxRow,
  type StudioProjection,
} from "./runtime/studio-project";
import {
  handleStudioFrame,
  parseInspectOptions,
  parseTimelineOptions,
  parseViewOptions,
  resolveTimelineSize,
  STUDIO_VIEWER_HEADER,
  type StudioTimelineEntry,
  type StudioViewer,
  type StudioViewReply,
  studioView,
  toTimelineEntry,
  viewerFromHeader,
  viewerFromTags,
  viewerTags,
} from "./runtime/studio-protocol";
import { compileRedaction } from "./runtime/studio-redact";
import { findStudioRegistry, looksLikeDONamespace } from "./runtime/studio-registry";
import {
  applyTimerOps,
  type DueTimer,
  deleteTimer,
  dueTimer,
  earliestDeadline,
  nextTimerAt,
  readTimers,
  type TimerRow,
  timerByKey,
  timerFailedEvent,
} from "./runtime/timers-store";
import { toRuntimeDef } from "./runtime/versions";

/** Reserved caller ID for studio WebSocket connections (stamped by the studio middleware). */
const STUDIO_CALLER_ID = "__studio";

// --- Studio registry helpers ---

/**
 * Resolve a singleton DO stub from a namespace-like binding.
 * Returns a stub with fire-and-forget RPC methods, or null if resolution fails.
 * The caller must use bracket-notation RPC since the stub type is not statically known.
 */
function resolveSingletonStub(binding: unknown, name: string): DurableObjectStub | null {
  if (!looksLikeDONamespace(binding)) return null;
  try {
    // Runtime: binding is a DurableObjectNamespace from CF. Call its methods directly.
    const ns = binding as DurableObjectNamespace;
    const doId = ns.idFromName(name);
    return ns.get(doId);
  } catch {
    return null;
  }
}

// --- Actor definition ---

// Runtime actor definition — uses structural types that erase generics.
// Type safety is enforced at the definition site (message(), view(), etc.),
// not at the runtime level. The DO class just needs schemas, handlers, and predicates.
// Runtime actor definition — uses bivariant method signatures throughout
// so that MessageDef<ConcreteState> is assignable without contravariance issues.
// Type safety is enforced at the definition site (message(), view(), etc.),
// not at the runtime level. The DO class just needs schemas, handlers, and predicates.
interface ActorMessageSlot {
  readonly schema: z.ZodType;
  handler(state: unknown, payload: unknown, ctx: unknown): unknown;
  guard?(state: unknown, payload: unknown, ctx: unknown): boolean; // bivariant method signature
}

interface ActorDef {
  input: z.ZodType;
  /** Typed env (ADR-016 §4): a Zod object, parsed once before the actor serves anything. */
  env?: EnvParser;
  init(
    input: unknown,
    ctx: { env: unknown; link: (name: string, id: string) => Promise<unknown> } & DeterministicContext,
  ): unknown | Promise<unknown>; // bivariant — optionally async, receives ctx
  /** The typed version chain (ADR-015 D5): `[version(1, Schema), version(2, Schema, { state, events })]`. */
  versions?: readonly unknown[];
  roles: Record<string, (state: unknown, caller: string, claims: { callerType: "user" | "service" }) => boolean>;
  messages?: Record<string, Record<string, ActorMessageSlot>>;
  views: Record<
    string,
    {
      kind?: "shared" | "perCaller"; // undefined = legacy (treated as perCaller)
      fn(state: unknown, caller: string): unknown; // bivariant — shared views ignore caller
      schema?: { fields: readonly { name: string; type: string }[] }; // optional schema for binary encoding
    }
  >;
  lifecycle?: {
    connect?(state: unknown, event: LifecycleEvent, ctx: unknown): unknown;
    disconnect?(state: unknown, event: LifecycleEvent, ctx: unknown): unknown;
  };
  observe?: {
    onTransition?(
      prevState: unknown,
      nextState: unknown,
      event: { type: string },
      ctx: { caller: string; role: string },
    ): void;
  };
  /** Durable timers (ADR-015 D2): `timer(schema, handler)` per name. */
  timers?: Record<
    string,
    { readonly schema: z.ZodType; handler(state: unknown, payload: unknown, ctx: unknown): unknown }
  >;
  services?: Record<
    string,
    {
      /**
       * Third argument (ADR-016 §1): the actor, the effect id (`seq:index`, stable across retries), the
       * idempotency key (`${actorType}/${actorId}/${effectId}`), the try number and the try's AbortSignal.
       */
      fn(input: unknown, env: unknown, effect: EffectInfo): Promise<unknown>;
      /** Time limit per try in ms (ADR-016 §3). Default 30 000. */
      timeoutMs?: number;
      /** Declared failures (ADR-016 §2): a `z.discriminatedUnion("_tag", ...)` that `fail(...)` values parse against. */
      errors?: ErrorsParser;
      /** Tries, backoff and `while` (ADR-015 D1, ADR-016 §2). Default: 3 tries, 1s then 5s apart, ±20% jitter. */
      retry?: unknown;
      onDone?(state: unknown, result: unknown, input: unknown, ctx: DeterministicContext): unknown;
      /** `error`: a declared error, `{ _tag: "Timeout", ms }` or `{ _tag: "Defect", message }`. */
      onError?(state: unknown, error: unknown, input: unknown, ctx: DeterministicContext): unknown;
    }
  >;
  links?: Record<
    string,
    {
      contract: { readonly name: string };
      onUpdate(state: unknown, view: unknown, id: string | undefined, ctx: DeterministicContext): unknown;
      onError?:
        | ((
            state: unknown,
            error: { message: string; code: string },
            id: string | undefined,
            ctx: DeterministicContext,
          ) => unknown)
        | undefined;
      onUnlink?: ((state: unknown, id: string | undefined, ctx: DeterministicContext) => unknown) | undefined;
      /** Tries and backoff for forwards through this link (ADR-015 D1). */
      retry?: unknown;
      /** Time limit per forward try in ms (ADR-016 §3). Default 30 000. */
      timeoutMs?: number | undefined;
    }
  >;
  serialize?(state: unknown): unknown;
  restore?(serialized: unknown): unknown;
  /** Event journal (ADR-013). Omitted: on, keep everything. `false`: off. `{ keep }`: prune. */
  journal?: JournalOption;
  studio?: {
    /**
     * true: force-enable timeline recording regardless of registry detection.
     * false: opt out — no timeline, no registry registration, every studio entry point is rejected.
     * undefined: enabled when a StudioRegistry is detected.
     */
    enabled?: boolean;
    /** Timeline ring-buffer size (positive integer, default 500). */
    timelineSize?: number;
    /**
     * Path globs redacted from everything Studio returns (ADR-014): state, cause data, outbox
     * payloads and views, each relative to its own root. `*` = one segment, `**` = any depth.
     * Example: ["players.*.name", "**.email"].
     */
    redact?: readonly string[];
  };
}

// --- Helpers ---

/** The snapshot row read on wake (parsed at the storage boundary). */
const SnapshotRowSchema = z.object({
  state: z.string(),
  version: z.number(),
  actor_id: z.string().nullable(),
});

const RedriveOptionsSchema = z.object({ effectId: z.string().min(1) });
const FireTimerOptionsSchema = z.object({ key: z.string().min(1) });
const RestoreOptionsSchema = z.object({ toSeq: z.number().int().positive() });
const SnapshotSeqSchema = z.object({ version: z.number(), last_seq: z.number() });
/** A recorded service result to redeliver after a restore (journal payloads carry the effect id). */
const RecordedResultSchema = z.union([
  z.object({ input: z.unknown(), result: z.unknown(), effectId: z.string() }),
  z.object({ input: z.unknown(), error: z.record(z.string(), z.unknown()), effectId: z.string() }),
]);

// SQL rows and RPC payloads, parsed at the boundary.
const TargetIdRowSchema = z.object({ target_id: z.string() });
const ActiveLinkRowSchema = z.object({ target_id: z.string(), link_name: z.string() });
const LinkVersionRowSchema = z.object({ link_name: z.string(), version: z.number() });
const SubscriberRowSchema = z.object({ subscriber_type: z.string(), subscriber_id: z.string() });
/** A message: an object with a string `type` (forwarded rows, WebSocket frames). */
const MessageEnvelopeSchema = z.looseObject({ type: z.string() });
const ViewFieldsSchema = z.record(z.string(), z.unknown());

/** What a linked actor's getSnapshot RPC returns (parsed at the RPC boundary). */
const LinkedSnapshotSchema = z.object({ snapshot: z.record(z.string(), z.unknown()), role: z.string() });

type RpcFunction = (...args: unknown[]) => Promise<unknown>;

function isRpcFunction(value: unknown): value is RpcFunction {
  return typeof value === "function";
}

/** A named RPC method on a stub (or null when the stub or the method is missing). */
function rpcMethod(stub: Record<string, unknown> | undefined, name: string): RpcFunction | null {
  const method = stub?.[name];
  return isRpcFunction(method) ? method : null;
}

/**
 * Safely extract the `exports` map from a DurableObjectState ctx.
 * In multi-DO Workers, the CF runtime populates ctx.exports with co-located bindings.
 * We access it via unknown to avoid casting DurableObjectState.
 */
/**
 * Complete the WebSocket close handshake from the server side.
 * Codes 1005/1006 (and anything outside the sendable ranges) can't be sent
 * back, so they are answered with 1000. Already-closed sockets are ignored.
 */
function answerClose(ws: WebSocket, code: number | undefined, reason: string | undefined): void {
  try {
    ws.close(closeCodeToSend(code), reason ?? "");
  } catch {
    // Socket already closed
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One try of a service: its result, or its typed error (ADR-016 §2: a declared error or a Defect). */
async function tryService(
  serviceDef: { fn(input: unknown, env: unknown, effect: EffectInfo): unknown; errors?: ErrorsParser | undefined },
  input: unknown,
  env: unknown,
  effect: EffectInfo,
): Promise<TryOutcome> {
  try {
    return { ok: true, result: await serviceDef.fn(input, env, effect) };
  } catch (error) {
    return { ok: false, error: classifyFailure(error, serviceDef.errors) };
  }
}

type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

/** One try of a forward: the target's answer, or the message the send failed with. */
async function trySend(
  send: RpcFunction,
  caller: string,
  callerType: "user" | "service",
  message: MessageEnvelope,
  delivery: DeliveryInfo,
): Promise<TryOutcome> {
  try {
    return { ok: true, result: await send(caller, callerType, message, delivery) };
  } catch (error) {
    return { ok: false, error: classifyFailure(error, undefined) };
  }
}

/** The binding name for an actor type: upper case, `-` → `_` (e.g. "chat-room" → "CHAT_ROOM"). */
const bindingName = (name: string): string => name.toUpperCase().replace(/-/g, "_");

/** A transition declared effects to persist: executions, forwards, or timer schedules / cancels. */
function declaresEffects(result: StepResult): boolean {
  const { effects } = result;
  return effects.getExecutions().length > 0 || effects.getForwards().length > 0 || effects.toTimerOps().length > 0;
}

/** send()'s answer for a message admission refused. */
function rejected(admission: { error: string; detail?: string | undefined }): {
  ok: false;
  error: string;
  detail?: string;
} {
  return admission.detail === undefined
    ? { ok: false, error: admission.error }
    : { ok: false, error: admission.error, detail: admission.detail };
}

/** The __error frame a socket gets for a message the actor refused. */
function rejectionFrame(message: string, result: { error?: string | undefined; detail?: string | undefined }) {
  const frame = { type: "__error", message, error: result.error };
  return result.detail === undefined ? frame : { ...frame, detail: result.detail };
}

/** ctx.exports itself (not a copy: its bindings may not all be enumerable). */
function getExports(ctx: unknown): Record<string, unknown> | undefined {
  if (!isRecord(ctx)) return undefined;
  const exports: unknown = Reflect.get(ctx, "exports");
  return isRecord(exports) ? exports : undefined;
}

/**
 * Resolve a DurableObject stub for a given actor type and ID.
 * Returns undefined if namespace or stub can't be resolved.
 */
function resolveStub(
  contractName: string,
  targetId: string,
  ctx: unknown,
  env: unknown,
): Record<string, unknown> | undefined {
  try {
    const ns = resolveNamespace(contractName, getExports(ctx), env as Record<string, unknown>);
    // DurableObjectNamespace shape
    const doNs = ns as { idFromName(name: string): unknown; get(id: unknown): Record<string, unknown> };
    const doId = doNs.idFromName(targetId);
    return doNs.get(doId);
  } catch {
    return undefined;
  }
}

// --- actor() function ---

export function actor(
  _actorName: string,
  actorDef: ActorDef,
): { new (ctx: DurableObjectState, env: Record<string, unknown>): DurableObject } {
  // The version chain (ADR-015 D5) compiles into version, migrate and upcast; the old `version` /
  // `migrate` options are refused.
  const def = toRuntimeDef(actorDef);
  // Validate studio config at definition time, not on the first mutation.
  const configuredTimelineSize = resolveTimelineSize(def.studio?.timelineSize);
  const studioRedactor = compileRedaction(def.studio?.redact);
  const journalConfig = resolveJournalConfig(def.journal);
  const retryPolicies = new Map<string, RetryPolicy>(
    Object.entries(def.services ?? {}).map(([name, service]) => [name, resolveRetryPolicy(service.retry)]),
  );
  const retryRules = new Map<string, (error: TaggedError) => boolean>(
    Object.entries(def.services ?? {}).map(([name, service]) => [name, resolveRetryRule(service.retry)]),
  );
  const forwardPolicies = linkRetryPolicies(def.links);
  const forwardRules = linkRetryRules(def.links);
  // Time limits per try (ADR-016 §3), validated at definition time.
  const serviceTimeouts = new Map<string, number>(
    Object.entries(def.services ?? {}).map(([name, s]) => [name, resolveTimeoutMs(s.timeoutMs, `service "${name}"`)]),
  );
  const forwardTimeouts = new Map<string, number>(
    Object.entries(def.links ?? {}).map(([name, l]) => [name, resolveTimeoutMs(l.timeoutMs, `link "${name}"`)]),
  );

  const DOClass = class ActorInstance extends DurableObject {
    state: unknown = undefined;
    actorId: string | undefined = undefined; // Human-readable ID (the name passed to idFromName)
    initialized = false;
    version: number;
    /** env stored with index signature — the base DurableObject.env lacks it. */
    envBindings: Record<string, unknown>;
    /** What handlers and services see as env: the parsed `env` schema's output, or the raw env without one. */
    handlerEnv: unknown = undefined;
    /** Set when the env does not match the actor's `env` schema: every request is refused with it. */
    envError: string | null = null;
    // Keyed by WebSocket (not caller) to support multi-tab/multi-device
    connections = new Map<WebSocket, { caller: string; callerType: "user" | "service" }>();
    previousViews = new Map<WebSocket, string>(); // dedupe key: "role:json"
    previousViewData = new Map<WebSocket, Record<string, unknown>>(); // actual view data for delta computation
    connectionChecksums = new Map<WebSocket, string>(); // last checksum sent per connection
    supportsBinary = new Map<WebSocket, boolean>(); // per-connection binary capability
    drainingExecutions = false; // Prevents concurrent execution drains
    inFlight = createInFlight(); // Tries running now, so redrive and restore can abort them (ADR-016 §3)
    timersChanged = false; // A commit scheduled or cancelled timers: push them to Studio after it
    journalAhead = false; // The snapshot lags the journal (same code version): rebuild it on wake
    rebuildFrom: number | null = null; // Stored version to rebuild from by replay (ADR-015 D5), on wake
    previousSubscriberViews = new Map<string, string>(); // dedupe: "type:id" → "role:json"

    // --- Timeline (studio instrumentation) ---
    studioEnabled = false; // Detected from ctx.exports on init
    pendingCause: MutationCause | null = null; // Set before persistState(), consumed by persistState()
    timelineSize = configuredTimelineSize; // Ring buffer max entries
    studioConnections = new Set<WebSocket>(); // Studio WebSocket connections (separate from app connections)
    registryStub: DurableObjectStub | null = null; // Cached StudioRegistry stub for RPC
    lastRegistryTouch = 0; // Timestamp of last registry touch (for debouncing)

    persistedLoaded = false; // loadPersisted() has run against existing storage
    studioDetected = false; // detectStudioConfig() has run
    autoSpawning: Promise<void> | null = null; // in-flight auto-spawn (prevents double init)
    callerHasher: CallerHasher | null = null; // Agent caller hashing (ADR-014), created on first use
    // Studio frames are projected asynchronously (caller hashing); one chain keeps them in order.
    studioSendChain: Promise<void> = Promise.resolve();

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.envBindings = env;
      this.version = def.version ?? 1;
      // Typed env (ADR-016 §4): parsed once, before anything is served. One that does not parse is
      // logged once; then every request is refused and no handler ever runs.
      const parsedEnv = parseActorEnv(def.env, env);
      if (!parsedEnv.ok) {
        this.envError = envErrorMessage(_actorName, parsedEnv.issues);
        console.error(JSON.stringify(envInvalidEvent(_actorName, parsedEnv.issues)));
        return;
      }
      this.handlerEnv = parsedEnv.env;
      // Restore persisted state before any requests are served (hibernation wake / restart).
      // blockConcurrencyWhile ensures no fetch/send/WebSocket during init.
      // Never creates storage: a DO that was never written stays empty until an entry
      // point that may create the actor (fetch/send/getSnapshot/spawn) calls loadState().
      this.ctx.blockConcurrencyWhile(async () => {
        this.loadPersisted({ create: false });
        await this.catchUpJournal();
      });
    }

    runMigrations(): void {
      new DOQB(this.ctx.storage.sql).migrations({ migrations: [...ACTOR_KIT_MIGRATIONS] }).apply();
    }

    /** Resolve studio enablement once: registry detection OR'd with the config flag; `enabled: false` opts out. */
    detectStudioConfig(): void {
      if (this.studioDetected) return;
      this.studioDetected = true;
      if (def.studio?.enabled === false) {
        this.studioEnabled = false;
        return;
      }
      const registryDetected = this.detectStudio();
      this.studioEnabled = registryDetected || def.studio?.enabled === true;
    }

    /** True if this DO has ever persisted actor state (read-only check, writes nothing). */
    hasActorStorage(): boolean {
      return (
        this.ctx.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
          .toArray().length > 0
      );
    }

    /**
     * Load persisted state (running SQL migrations and version migration). Never auto-spawns.
     * With `create: false`, a DO with no actor storage is left untouched (no tables, no rows).
     */
    loadPersisted({ create }: { create: boolean }): void {
      this.assertEnv();
      this.detectStudioConfig();
      if (this.persistedLoaded) return;
      if (!create && !this.hasActorStorage()) return;
      this.persistedLoaded = true;

      this.runMigrations();

      const [first] = this.ctx.storage.sql
        .exec("SELECT state, version, actor_id FROM snapshots WHERE id = 1")
        .toArray();
      if (first === undefined) return;
      this.restoreSnapshot(SnapshotRowSchema.parse(first));
      this.resumeAfterLoad();
    }

    /** Refuse to serve anything (no handler runs) when the env did not parse (ADR-016 §4). */
    assertEnv(): void {
      if (this.envError !== null) throw new Error(this.envError);
    }

    /** Put the stored snapshot in memory, migrating it through the step core when its version is older. */
    restoreSnapshot(row: z.infer<typeof SnapshotRowSchema>): void {
      const persisted: unknown = JSON.parse(row.state);
      this.journalAhead = this.isJournalAhead();
      const migration = this.loadMigration(row.version, persisted);
      this.state = migration !== null ? migration.state : def.restore ? def.restore(persisted) : persisted;

      // Restore actor ID
      if (row.actor_id !== null) {
        this.actorId = row.actor_id;
      }

      this.initialized = true;

      // Re-sync the registry's connection count: a restart drops every socket
      // without running webSocketClose, a hibernation wake keeps them.
      this.updateRegistryConnections();

      // Persist the migrated state once (stamped with the new version) and record it on the timeline.
      if (migration !== null) {
        this.pendingCause = { type: "migrate", fromVersion: row.version, toVersion: this.version };
        this.commit(this.state, migration.event);
      }
    }

    /**
     * The migrate transition for state stored at `storedVersion`, or null when there is none. A bump
     * across a version that rebuilds by replay waits for catchUpJournal() instead (replay is async).
     */
    loadMigration(storedVersion: number, persisted: unknown): StepResult | null {
      const rebuild = this.needsRebuild(storedVersion);
      this.rebuildFrom = rebuild ? storedVersion : null;
      if (rebuild || def.migrate === undefined || storedVersion === this.version) return null;
      return this.runStep({ type: "migrate", fromVersion: storedVersion, toVersion: this.version, persisted });
    }

    needsRebuild(storedVersion: number): boolean {
      return storedVersion !== this.version && storedVersion < (def.rebuildVersion ?? 0);
    }

    /** After a load: resume interrupted effects and links. */
    resumeAfterLoad(): void {
      // Drain any pending executions from before crash/restart; tries cut off mid-flight run again.
      requeueInterrupted(this.ctx.storage.sql);
      this.drainExecutions();

      // Drain any pending forwards from before crash/restart
      this.drainForwards();

      // Re-register active link subscriptions
      if (def.links) {
        this.reRegisterLinks();
      }
    }

    /** Load persisted state, auto-spawning with empty input if the actor doesn't exist yet. */
    async loadState(): Promise<void> {
      this.loadPersisted({ create: true });
      await this.catchUpJournal();
      if (this.initialized) return;
      this.autoSpawning ??= this.autoSpawn().finally(() => {
        this.autoSpawning = null;
      });
      await this.autoSpawning;
    }

    /** No persisted state — try auto-spawn with empty input. */
    async autoSpawn(): Promise<void> {
      const emptyParsed = def.input.safeParse({});
      // If input requires fields, stay uninitialized — spawn() must be called explicitly
      if (!emptyParsed.success) return;

      this.actorId = this.ctx.id.toString();
      const init = await stepInit(
        def,
        { input: emptyParsed.data, caller: null, callerType: null },
        liveStepFacts(createLiveFacts(), () => []),
        {
          env: this.handlerEnv,
          link: async () => {
            throw new Error("link() not available during auto-spawn");
          },
        },
      );

      this.pendingCause = { type: "init" };
      this.commit(init.state, init.event);
      this.initialized = true;
    }

    /** Detect StudioRegistry in ctx.exports or env and cache the stub. */
    detectStudio(): boolean {
      const registry = findStudioRegistry(getExports(this.ctx), this.envBindings);
      if (registry === undefined) return false;
      const stub = resolveSingletonStub(registry, "registry");
      if (stub) this.registryStub = stub;
      return true;
    }

    /**
     * Fire-and-forget: touch the registry to update last_active_at (debounced 10s).
     * `previousActorId` tells the registry to re-key a row registered under an older ID.
     */
    touchRegistry(previousActorId?: string): void {
      if (this.registryStub === null) return;
      const now = Date.now();
      if (now - this.lastRegistryTouch < 10_000) return; // Debounce: 10 seconds
      this.lastRegistryTouch = now;

      try {
        // RPC via Cloudflare's stub proxy — touch() is defined on StudioRegistry DO class
        const stub: Record<string, unknown> = this.registryStub;
        const touchFn = stub["touch"];
        if (typeof touchFn === "function") {
          void touchFn(
            _actorName,
            this.actorId ?? this.ctx.id.toString(),
            this.version,
            previousActorId,
            this.ctx.id.toString(),
          );
        }
      } catch {
        // Fire and forget
      }
    }

    /** App connections from the sockets this DO holds right now (survives hibernation, empty after restart). */
    liveConnections(exclude?: WebSocket): LiveConnection[] {
      return toLiveConnections(this.socketRecords(exclude), def.roles, this.state);
    }

    private socketRecords(exclude?: WebSocket): SocketRecord[] {
      return this.ctx
        .getWebSockets()
        .filter((ws) => ws !== exclude)
        .map((ws) => ({ tags: this.ctx.getTags(ws), attachment: ws.deserializeAttachment() }));
    }

    /** Open app sockets held by one caller (same caller + callerType); `exclude` is left out. */
    callerConnectionCount(caller: string, callerType: "user" | "service", exclude?: WebSocket): number {
      return this.liveConnections(exclude).filter((c) => c.caller === caller && c.callerType === callerType).length;
    }

    /**
     * Fire-and-forget: update connection count in the registry.
     * Counts the live app connections (one per socket, read from ctx.getWebSockets()), so it
     * survives hibernation and matches what Studio lists. `closing` is excluded from the count.
     */
    updateRegistryConnections(closing?: WebSocket): void {
      if (this.registryStub === null) return;
      const count = this.liveConnections(closing).length;

      try {
        const stub: Record<string, unknown> = this.registryStub;
        const updateFn = stub["updateConnections"];
        if (typeof updateFn === "function") {
          void updateFn(_actorName, this.actorId ?? this.ctx.id.toString(), count, this.ctx.id.toString());
        }
      } catch {
        // Fire and forget
      }
    }

    /**
     * Apply a transition atomically: set the state, number the transition (`seq`, read from
     * storage), run `writes` (outbox, links) with that seq, then persist the snapshot and append its
     * journal event, all in one transaction. On failure nothing is written and the in-memory
     * state is put back.
     */
    commit(nextState: unknown, draft: JournalDraft, writes?: (seq: number) => void): void {
      const previous = this.state;
      this.state = nextState;
      try {
        this.ctx.storage.transactionSync(() => {
          const seq = nextTransitionSeq(this.ctx.storage.sql);
          writes?.(seq);
          this.persistState(draft, seq);
        });
      } catch (error) {
        this.state = previous;
        this.pendingCause = null;
        this.timersChanged = false;
        throw error;
      }
      this.syncAlarm();
      if (this.timersChanged) {
        this.timersChanged = false;
        this.pushStudioTimers();
      }
    }

    /** Write the snapshot (and its journal event). Only call inside commit()'s transaction. */
    persistState(draft: JournalDraft, seq: number): void {
      const serialized = def.serialize ? def.serialize(this.state) : this.state;
      const json = JSON.stringify(serialized);
      const checksum = this.computeChecksum(json);
      const now = Date.now();

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO snapshots (id, version, state, state_tracker, actor_id, checksum, updated_at, last_seq) VALUES (1, ?, ?, NULL, ?, ?, ?, ?)",
        this.version,
        json,
        this.actorId ?? null,
        checksum,
        now,
        seq,
      );

      if (journalConfig.enabled) {
        appendJournalEvent(this.ctx.storage.sql, journalConfig, draft, {
          seq,
          stateJson: json,
          checksum,
          version: this.version,
          now,
        });
      }

      // Timeline instrumentation — write entry if studio is enabled and a cause is pending
      const cause = this.pendingCause;
      this.pendingCause = null;
      if (this.studioEnabled && cause !== null) {
        const { type: causeType, ...causeRest } = cause;
        const causeDataJson = JSON.stringify(causeRest);
        const entry = toTimelineEntry(
          this.ctx.storage.sql
            .exec(
              "INSERT INTO timeline (cause_type, cause_data, state_snapshot, checksum, created_at, seq) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, cause_type, cause_data, state_snapshot, checksum, created_at, seq",
              causeType,
              causeDataJson,
              json,
              checksum,
              now,
              seq,
            )
            .one(),
        );

        // Ring buffer pruning
        this.pruneTimeline();

        // Touch registry (debounced)
        this.touchRegistry();

        // Push to studio connections (covers hibernated sockets too)
        if (this.hasStudioWs()) {
          this.broadcastToStudio(async (projection) => ({
            type: "studio.timeline",
            entry: await projectTimelineEntry(entry, projection),
          }));
        }
      }
    }

    /** Prune timeline to keep at most timelineSize entries. */
    pruneTimeline(): void {
      this.ctx.storage.sql.exec(
        "DELETE FROM timeline WHERE id NOT IN (SELECT id FROM timeline ORDER BY id DESC LIMIT ?)",
        this.timelineSize,
      );
    }

    computeChecksum(json: string): string {
      return xxh64(json);
    }

    /**
     * Point the DO's single alarm at the earliest outbox retry, or clear it when nothing waits.
     * Runs after every commit and every settled try.
     */
    syncAlarm(): void {
      const next = earliestDeadline(nextTimerAt(this.ctx.storage.sql), nextRetryAt(this.ctx.storage.sql));
      if (next === null) {
        void this.ctx.storage.deleteAlarm();
      } else {
        void this.ctx.storage.setAlarm(next);
      }
    }

    /**
     * DO alarm: fire every due timer (late ones too, in (fire_at, id) order, each in its own
     * transaction), run the outbox retries that are due, then re-arm for the next deadline.
     */
    async alarm(): Promise<void> {
      if (this.envError !== null) return;
      this.loadPersisted({ create: false });
      if (!this.initialized) return;
      this.fireDueTimers(Date.now());
      await this.drainExecutions();
      await this.drainForwards();
      this.syncAlarm();
    }

    /** Fire due timers one at a time. Timers scheduled while firing wait for the next alarm. */
    fireDueTimers(now: number): void {
      const sql = this.ctx.storage.sql;
      const scheduledBy = nextTransitionSeq(sql) - 1;
      for (let due = dueTimer(sql, now, scheduledBy); due !== null; due = dueTimer(sql, now, scheduledBy)) {
        this.fireTimer(due, now);
      }
    }

    /**
     * Fire one timer: its handler runs through the step core and commits with the timer's row
     * deleted. A timer whose payload no longer parses, or whose transition fails, is dropped and
     * logged (it would otherwise fail on every alarm).
     */
    fireTimer(due: DueTimer, now: number): void {
      const sql = this.ctx.storage.sql;
      const lateBy = Math.max(0, now - due.fireAt);
      const parsed = def.timers?.[due.name]?.schema.safeParse(due.payload);
      try {
        if (parsed !== undefined && !parsed.success) throw new Error(`invalid payload: ${parsed.error.message}`);
        const payload = parsed?.success ? parsed.data : due.payload;
        const result = this.runStep({ type: "timer", ...due, payload, lateBy }, now);
        this.pendingCause = { type: "timer", name: due.name, key: due.key, payload, fireAt: due.fireAt, lateBy };
        this.commit(result.state, result.event, (seq) => {
          deleteTimer(sql, due.id);
          this.writeEffects(result, seq, `timer:${due.name}`, "service");
        });
        this.afterEffects(result);
      } catch (error) {
        deleteTimer(sql, due.id);
        console.error(JSON.stringify(timerFailedEvent(_actorName, this.actorId ?? this.ctx.id.toString(), due, error)));
      }
      this.pushStudioTimers();
    }

    /** After a committed transition: views, Studio, and draining the effects it declared. */
    afterEffects(result: StepResult): void {
      this.broadcastViews();
      if (result.effects.getExecutions().length > 0) {
        this.pushStudioOutbox();
        this.drainExecutions();
      }
      if (result.effects.getForwards().length > 0) {
        this.drainForwards();
      }
    }

    async drainExecutions(): Promise<void> {
      if (this.drainingExecutions) return;
      this.drainingExecutions = true;
      try {
        await this.drainExecutionsInner();
      } finally {
        this.drainingExecutions = false;
      }
    }

    /** Run due rows, oldest effect first, until none are due (rows added meanwhile are picked up). */
    async drainExecutionsInner(): Promise<void> {
      for (;;) {
        const due = dueExecutions(this.ctx.storage.sql, Date.now());
        if (due.length === 0) return;
        for (const entry of due) {
          await this.runExecution(entry);
        }
      }
    }

    /** One try of one execution: settle the row and, on the outcome that ends it, run onDone/onError. */
    async runExecution(entry: { id: string; service: string; input: unknown }): Promise<void> {
      const sql = this.ctx.storage.sql;
      const serviceDef = def.services?.[entry.service];
      const policy = retryPolicies.get(entry.service);
      if (serviceDef === undefined || policy === undefined) {
        finishAttempt(sql, entry.id, { status: "failed" }, `Service "${entry.service}" is not defined`);
        this.pushStudioOutbox();
        return;
      }

      const attempt = startAttempt(sql, entry.id);
      this.pushStudioOutbox();
      const outcome = await this.tryExecution(entry, serviceDef, attempt);

      // Aborted (a restore undid its transition, or a redrive replaced it): discard the result, settle nothing.
      if ("aborted" in outcome || !isRunning(sql, entry.id)) {
        this.pushStudioOutbox();
        return;
      }

      const rule = retryRules.get(entry.service) ?? isBuiltInError;
      const settled = settleTry(outcome, attempt, { policy, rule }, Date.now(), Math.random);
      const settle = () => {
        finishAttempt(sql, entry.id, settled.settlement, settled.lastError, "executions", settled.lastErrorTag);
      };

      if (settled.settlement.status === "retrying") {
        settle();
        this.syncAlarm();
      } else {
        this.endExecution(entry, attempt, outcome, settled, settle);
      }
      this.pushStudioOutbox();
    }

    /** Run one try of a service under its time limit, registered as in flight (ADR-016 §3). */
    async tryExecution(
      entry: { id: string; service: string; input: unknown },
      serviceDef: { fn(input: unknown, env: unknown, effect: EffectInfo): unknown; errors?: ErrorsParser | undefined },
      attempt: number,
    ): Promise<AttemptResult> {
      const controller = new AbortController();
      this.inFlight.start("executions", entry.id, controller);
      const fields = { actorType: _actorName, actorId: this.subscriberId(), effectId: entry.id, attempt };
      const ms = serviceTimeouts.get(entry.service) ?? DEFAULT_TIMEOUT_MS;
      const outcome = await runAttempt(
        (signal) => tryService(serviceDef, entry.input, this.handlerEnv, effectInfo({ ...fields, signal })),
        ms,
        controller,
      );
      this.inFlight.finish("executions", entry.id, controller);
      return outcome;
    }

    /** The try that ends a row: log a dead letter, then run onDone/onError with the final status. */
    endExecution(
      entry: { id: string; service: string; input: unknown },
      attempt: number,
      outcome: TryOutcome,
      settled: SettledTry,
      settle: () => void,
    ): void {
      if (settled.lastError !== null) {
        this.logDeadLetter("execution", entry.id, entry.service, attempt, settled.lastError, settled.lastErrorTag);
      }
      try {
        this.settleExecution(entry.service, entry.id, entry.input, outcome, settle);
      } catch (error) {
        // onDone/onError threw, or its transition could not be persisted: nothing was written.
        // The row ends as a dead letter carrying the reason, instead of staying `running`.
        const reason = error instanceof Error ? error.message : String(error);
        const which = outcome.ok ? "onDone" : "onError";
        finishAttempt(this.ctx.storage.sql, entry.id, { status: "failed" }, `${which}: ${reason}`);
      }
    }

    /** Run onDone/onError for a try that ended the row, committing it with the row's final status. */
    settleExecution(service: string, effectId: string, input: unknown, outcome: TryOutcome, settle: () => void): void {
      const cause: StepCause = outcome.ok
        ? { type: "service.onDone", service, input, result: outcome.result, effectId }
        : { type: "service.onError", service, input, error: { ...outcome.error }, effectId };
      const result = this.runStep(cause);
      if (result.state === this.state) {
        settle();
        return;
      }
      this.pendingCause = outcome.ok
        ? { type: "service.onDone", service, input, result: outcome.result }
        : { type: "service.onError", service, input, error: describeServiceError(outcome.error) };
      this.commit(result.state, result.event, settle);
      this.broadcastViews();
    }

    /** Run one transition through the step core with live facts (now/id/random, stored link targets). */
    runStep(cause: StepCause, now?: number): StepResult {
      const live = createLiveFacts(now === undefined ? undefined : clockedSources(now));
      const facts = liveStepFacts(live, (name) => this.readLinkTargets(name));
      return step(def, this.state, cause, facts, this.handlerEnv);
    }

    /** The snapshot (at this code version) is behind the journal's last seq. */
    isJournalAhead(): boolean {
      if (!journalConfig.enabled) return false;
      const sql = this.ctx.storage.sql;
      const row = SnapshotSeqSchema.parse(sql.exec("SELECT version, last_seq FROM snapshots WHERE id = 1").one());
      return row.version === this.version && row.last_seq < journalHighWater(sql);
    }

    /**
     * Replay on wake (ADR-015 D3): when the snapshot lags the journal, rebuild the state by folding
     * the journal from its newest usable checkpoint, then write the snapshot up to date. A journal
     * that does not replay leaves the snapshot as it was (and is logged).
     */
    async catchUpJournal(): Promise<void> {
      if (this.rebuildFrom !== null) {
        await this.rebuildByReplay(this.rebuildFrom);
        return;
      }
      if (!this.journalAhead) return;
      this.journalAhead = false;
      const sql = this.ctx.storage.sql;
      const journal = readJournal(sql);
      try {
        const { state } = await foldJournal(def, journal, { env: this.handlerEnv });
        const json = JSON.stringify(def.serialize ? def.serialize(state) : state);
        sql.exec(
          "UPDATE snapshots SET state = ?, checksum = ?, last_seq = ?, updated_at = ? WHERE id = 1",
          json,
          this.computeChecksum(json),
          journal.events.at(-1)?.seq ?? 0,
          Date.now(),
        );
        this.state = state;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          JSON.stringify({ event: "actor_kit.journal.replay_failed", actorType: _actorName, error: message }),
        );
      }
    }

    /**
     * A version bump across `rebuild: "replay"` (ADR-015 D5): the state is what the new handlers make
     * of the whole journal (older payloads upcast), journaled as a migrate event with a checkpoint.
     */
    async rebuildByReplay(fromVersion: number): Promise<void> {
      this.rebuildFrom = null;
      const state = await rebuildFromJournal(def, readJournal(this.ctx.storage.sql), { env: this.handlerEnv });
      this.pendingCause = { type: "migrate", fromVersion, toVersion: this.version };
      this.commit(state, {
        causeType: "migrate",
        name: null,
        payload: { fromVersion, toVersion: this.version },
        caller: null,
        callerType: null,
        role: null,
        facts: {},
      });
    }

    /** Targets stored under a link name, in insertion order (what `unlink(name)` removes). */
    readLinkTargets(name: string): string[] {
      return this.ctx.storage.sql
        .exec("SELECT target_id FROM active_links WHERE link_name = ? ORDER BY rowid", name)
        .toArray()
        .map((row) => TargetIdRowSchema.parse(row).target_id);
    }

    // --- Forward processing ---

    drainingForwards = false;

    persistForwards(
      entries: Array<{
        id: string;
        seq: number;
        index: number;
        linkName: string;
        targetId: string;
        message: { type: string; [key: string]: unknown };
        status: string;
        attempts: number;
        createdAt: number;
      }>,
      caller: string,
      callerType: "user" | "service",
    ): void {
      insertForwards(this.ctx.storage.sql, entries, caller, callerType);
    }

    async drainForwards(): Promise<void> {
      if (this.drainingForwards) return;
      this.drainingForwards = true;
      try {
        await this.drainForwardsInner();
      } finally {
        this.drainingForwards = false;
      }
    }

    /** Send due forwards, oldest effect first, until none are due (rows added meanwhile are picked up). */
    async drainForwardsInner(): Promise<void> {
      for (;;) {
        const due = dueForwards(this.ctx.storage.sql, Date.now());
        if (due.length === 0) return;
        for (const entry of due) {
          await this.deliverForward(entry);
        }
      }
    }

    /**
     * One try of one forward. A target that cannot be resolved, or a stored message that is not a
     * message, is a dead letter at once (retrying cannot help); a send that throws is retried by the
     * link's policy. A target that answers (even with a refusal) is done.
     */
    async deliverForward(entry: DueForward): Promise<void> {
      const sql = this.ctx.storage.sql;
      const target = this.forwardTarget(entry);
      if (!target.ok) {
        finishAttempt(sql, entry.id, { status: "failed" }, target.error, "forwards");
        this.logDeadLetter("forward", entry.id, entry.linkName, 0, target.error);
        this.pushStudioOutbox();
        return;
      }

      const attempt = startAttempt(sql, entry.id, "forwards");
      this.pushStudioOutbox();
      const callerType: "user" | "service" = entry.callerType === "service" ? "service" : "user";
      const delivery = deliveryInfo({
        actorType: _actorName,
        actorId: this.subscriberId(),
        effectId: entry.id,
        attempt,
      });
      const controller = new AbortController();
      this.inFlight.start("forwards", entry.id, controller);
      const ms = forwardTimeouts.get(entry.linkName) ?? DEFAULT_TIMEOUT_MS;
      const outcome = await runAttempt(
        () => trySend(target.send, entry.caller, callerType, target.message, delivery),
        ms,
        controller,
      );
      this.inFlight.finish("forwards", entry.id, controller);

      // Aborted, or a restore cancelled this try while it ran: its transition is undone, settle nothing.
      if (!("aborted" in outcome) && isRunning(sql, entry.id, "forwards")) this.settleForward(entry, attempt, outcome);
      this.pushStudioOutbox();
    }

    /** Record how a forward's try ended: done, retrying (re-arm the alarm) or a dead letter. */
    settleForward(entry: DueForward, attempt: number, outcome: TryOutcome): void {
      const policy = forwardPolicies.get(entry.linkName) ?? DEFAULT_RETRY_POLICY;
      const rule = forwardRules.get(entry.linkName) ?? isBuiltInError;
      const { settlement, lastError, lastErrorTag } = settleTry(
        outcome,
        attempt,
        { policy, rule },
        Date.now(),
        Math.random,
      );
      finishAttempt(this.ctx.storage.sql, entry.id, settlement, lastError, "forwards", lastErrorTag);
      if (settlement.status === "retrying") this.syncAlarm();
      if (lastError !== null && settlement.status === "failed") {
        this.logDeadLetter("forward", entry.id, entry.linkName, attempt, lastError, lastErrorTag);
      }
    }

    /** The target's send() and the parsed message, or why the forward can never be delivered. */
    forwardTarget(
      entry: DueForward,
    ): { ok: true; send: RpcFunction; message: MessageEnvelope } | { ok: false; error: string } {
      // Resolve contract name: prefer declared link def, else lowercase the link name.
      const linkDef = def.links?.[entry.linkName];
      const contractName = linkDef ? linkDef.contract.name : entry.linkName.toLowerCase().replace(/_/g, "-");
      const send = rpcMethod(resolveStub(contractName, entry.targetId, this.ctx, this.env), "send");
      if (send === null) {
        return { ok: false, error: `Forward target "${contractName}" ${entry.targetId} cannot be resolved` };
      }
      const parsed = MessageEnvelopeSchema.safeParse(JSON.parse(entry.message));
      if (!parsed.success) return { ok: false, error: `Forward message is invalid: ${parsed.error.message}` };
      return { ok: true, send, message: parsed.data };
    }

    /** The wide event for an effect that became a dead letter (never its input). */
    logDeadLetter(
      kind: "execution" | "forward",
      effectId: string,
      service: string,
      attempts: number,
      error: string,
      errorTag: string | null = null,
    ) {
      const actorId = this.actorId ?? this.ctx.id.toString();
      const fields = { kind, actorType: _actorName, actorId, effectId, service, attempts, error };
      const event = outboxFailedEvent(errorTag === null ? fields : { ...fields, errorTag });
      console.error(JSON.stringify(event));
    }

    // --- Link processing (subscriber side) ---

    /** Persist a transition's effects under its seq (inside commit()'s transaction). */
    writeEffects(result: StepResult, seq: number, caller: string, callerType: "user" | "service"): void {
      insertExecutions(this.ctx.storage.sql, result.effects.toExecutionEntries(seq));
      const linkCalls = result.effects.getLinks();
      const unlinkCalls = result.effects.getUnlinks();
      if (linkCalls.length > 0 || unlinkCalls.length > 0) {
        this.writeLinks(linkCalls, unlinkCalls);
      }
      this.persistForwards(result.effects.toForwardEntries(seq), caller, callerType);
      const timerOps = result.effects.toTimerOps(seq);
      if (timerOps.length > 0) {
        applyTimerOps(this.ctx.storage.sql, timerOps, Date.now());
        this.timersChanged = true;
      }
    }

    /**
     * Persist link intents captured during a message handler (onUnlink already ran in the step),
     * then asynchronously register with target actors.
     */
    writeLinks(
      linkCalls: Array<{ name: string; id: string }>,
      unlinkCalls: Array<{ name: string; id: string | undefined }>,
    ): void {
      // Persist link intents atomically (already inside the send() transaction)
      for (const call of linkCalls) this.insertLink(call.name, call.id, "INSERT OR IGNORE");
      for (const call of unlinkCalls) this.deleteLink(call.name, call.id);

      // Async: register subscriptions with target actors (fire-and-forget)
      if (linkCalls.length > 0) {
        this.registerSubscriptions(linkCalls);
      }
      if (unlinkCalls.length > 0) {
        this.unregisterSubscriptions(unlinkCalls);
      }
    }

    /** Record an active link (declared links only), at version 0. */
    insertLink(name: string, id: string, insert: "INSERT OR IGNORE" | "INSERT OR REPLACE"): void {
      const linkDef = def.links?.[name];
      if (!linkDef) return;
      this.ctx.storage.sql.exec(
        `${insert} INTO active_links (target_type, target_id, link_name, version, created_at) VALUES (?, ?, ?, 0, ?)`,
        bindingName(linkDef.contract.name),
        id,
        name,
        Date.now(),
      );
    }

    /** Drop one target of a link, or (no id) every target of it. */
    deleteLink(name: string, id: string | undefined): void {
      const linkDef = def.links?.[name];
      if (!linkDef) return;
      if (id === undefined) {
        this.ctx.storage.sql.exec("DELETE FROM active_links WHERE link_name = ?", name);
        return;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM active_links WHERE target_type = ? AND target_id = ? AND link_name = ?",
        bindingName(linkDef.contract.name),
        id,
        name,
      );
    }

    /**
     * The ID a target uses to reach this actor back. Targets resolve it with
     * idFromName(), so it must be the actor's name, not the hex Durable Object ID.
     */
    subscriberId(): string {
      return this.actorId ?? this.ctx.id.toString();
    }

    /**
     * Register this actor as a subscriber on target actors.
     * Fire-and-forget — if target is unreachable, re-registration happens on restart.
     */
    async registerSubscriptions(calls: Array<{ name: string; id: string }>): Promise<void> {
      for (const call of calls) {
        const linkDef = def.links?.[call.name];
        if (!linkDef) continue;
        try {
          const subscribe = rpcMethod(
            resolveStub(linkDef.contract.name, call.id, this.ctx, this.env),
            "__linkSubscribe",
          );
          await subscribe?.(bindingName(_actorName), this.subscriberId());
        } catch (error) {
          // Target unreachable — invoke onError if defined, otherwise retry on restart
          this.linkUnreachable(call.name, call.id, error);
        }
      }
    }

    /** A link target could not be reached: run the link's onError, if it has one. */
    linkUnreachable(name: string, targetId: string, error: unknown): void {
      const linkDef = def.links?.[name];
      if (!linkDef?.onError) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result = this.runStep({
        type: "link.onError",
        link: name,
        targetId,
        error: { message: errorMessage, code: "unreachable" },
      });
      if (result.state === this.state) return;
      this.pendingCause = {
        type: "link.onError",
        sourceType: bindingName(linkDef.contract.name),
        sourceId: targetId,
        error: errorMessage,
      };
      this.commit(result.state, result.event);
      this.broadcastViews();
    }

    /**
     * Unregister this actor from target actors.
     */
    async unregisterSubscriptions(calls: Array<{ name: string; id: string | undefined }>): Promise<void> {
      for (const call of calls) {
        const linkDef = def.links?.[call.name];
        if (!linkDef) continue;

        // Get affected target IDs
        let targetIds: string[];
        if (call.id !== undefined) {
          targetIds = [call.id];
        } else {
          // All targets for this link name were already deleted from active_links
          // We don't have the IDs anymore, so we can't unsubscribe from them.
          // This is acceptable — the target will push and the subscriber will ignore.
          continue;
        }

        for (const targetId of targetIds) {
          try {
            const unsubscribe = rpcMethod(
              resolveStub(linkDef.contract.name, targetId, this.ctx, this.env),
              "__linkUnsubscribe",
            );
            if (unsubscribe !== null) {
              await unsubscribe(_actorName.toUpperCase().replace(/-/g, "_"), this.subscriberId());
            }
          } catch {
            // Target unreachable — acceptable
          }
        }
      }
    }

    // --- Source-side RPC methods (called by subscribers) ---

    /** Register a subscriber DO for push updates. */
    async __linkSubscribe(subscriberType: string, subscriberId: string): Promise<void> {
      await this.loadState();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO link_subscribers (subscriber_type, subscriber_id, subscribed_at) VALUES (?, ?, ?)",
        subscriberType,
        subscriberId,
        Date.now(),
      );
      this.pushStudioLinks();

      // Immediately push current view to the new subscriber
      if (this.initialized) {
        this.pushToSubscriber(subscriberType, subscriberId);
      }
    }

    /** Unregister a subscriber DO. */
    async __linkUnsubscribe(subscriberType: string, subscriberId: string): Promise<void> {
      await this.loadState();
      this.ctx.storage.sql.exec(
        "DELETE FROM link_subscribers WHERE subscriber_type = ? AND subscriber_id = ?",
        subscriberType,
        subscriberId,
      );
      // Clean up dedupe state
      this.previousSubscriberViews.delete(`${subscriberType}:${subscriberId}`);
      this.pushStudioLinks();
    }

    // --- Subscriber-side RPC method (called by source actors) ---

    /**
     * Receive a link update from a source actor.
     * Runs onUpdate reducer and broadcasts own views if state changed.
     */
    async __receiveLinkUpdate(
      sourceType: string,
      sourceId: string,
      viewData: unknown,
      role: string,
      version: number,
    ): Promise<void> {
      await this.loadState();
      if (!this.initialized) return;

      // Find the link handler for this source
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT link_name, version FROM active_links WHERE target_type = ? AND target_id = ?",
          sourceType,
          sourceId,
        )
        .toArray();

      for (const row of rows) {
        const link = LinkVersionRowSchema.parse(row);
        // Monotonic version check
        if (version > link.version) this.applyLinkUpdate(link.link_name, sourceType, sourceId, viewData, role, version);
      }
    }

    /** Run a link's onUpdate with the source's view (role added) and commit it with the link's new version. */
    applyLinkUpdate(
      linkName: string,
      sourceType: string,
      sourceId: string,
      viewData: unknown,
      role: string,
      version: number,
    ): void {
      if (!def.links?.[linkName]) return;

      // Add role discriminant to view data
      const fields = ViewFieldsSchema.safeParse(viewData);
      const viewWithRole = { ...(fields.success ? fields.data : {}), role };

      // Run onUpdate reducer
      const result = this.runStep({ type: "link.onUpdate", link: linkName, sourceId, view: viewWithRole });
      if (result.state === this.state) return;
      this.pendingCause = { type: "link.onUpdate", sourceType, sourceId, viewData: viewWithRole };
      this.commit(result.state, result.event, () => {
        this.ctx.storage.sql.exec(
          "UPDATE active_links SET version = ? WHERE target_type = ? AND target_id = ? AND link_name = ?",
          version,
          sourceType,
          sourceId,
          linkName,
        );
        this.pushStudioLinks();
      });
      this.broadcastViews();
    }

    // --- Source-side push to DO subscribers ---

    /**
     * Push view updates to all DO subscribers.
     * Called after broadcastViews() to keep DO subscribers in sync.
     */
    pushToSubscribers(): void {
      const rows = this.ctx.storage.sql.exec("SELECT subscriber_type, subscriber_id FROM link_subscribers").toArray();

      for (const row of rows) {
        const { subscriber_type, subscriber_id } = SubscriberRowSchema.parse(row);
        this.pushToSubscriber(subscriber_type, subscriber_id);
      }
    }

    /**
     * Push view to a single DO subscriber.
     */
    pushToSubscriber(subscriberType: string, subscriberId: string): void {
      // Resolve subscriber's role (same as for WebSocket clients)
      // For DO subscribers, caller = "actorname:do-id" and callerType = "service"
      const callerString = `${_actorName}:${subscriberId}`;
      const role = resolveRole(def.roles, this.state, callerString, { callerType: "service" });
      if (role === null) return;

      const viewDef = def.views[role];
      if (viewDef === undefined) return;

      const viewData = viewDef.fn(this.state, callerString);
      const dedupeKey = `${role}:${JSON.stringify(viewData)}`;
      const subKey = `${subscriberType}:${subscriberId}`;

      // Skip if unchanged
      const prev = this.previousSubscriberViews.get(subKey);
      if (dedupeKey === prev) return;
      this.previousSubscriberViews.set(subKey, dedupeKey);

      // Resolve subscriber namespace and call __receiveLinkUpdate RPC
      // This is fire-and-forget — if unreachable, subscriber re-registers on restart
      const sourceType = _actorName.toUpperCase().replace(/-/g, "_");
      const sourceId = this.actorId ?? this.ctx.id.toString();
      const version = Date.now(); // Monotonic version using timestamp

      try {
        const receive = rpcMethod(
          resolveStub(subscriberType.toLowerCase().replace(/_/g, "-"), subscriberId, this.ctx, this.env),
          "__receiveLinkUpdate",
        );
        if (receive !== null) {
          // Fire and forget
          void receive(sourceType, sourceId, viewData, role, version);
        }
      } catch {
        // Subscriber unreachable — skip
      }
    }

    // --- Re-registration on restart ---

    /**
     * Re-register all active links after restart.
     * Called once after state is loaded from persistence.
     */
    reRegisterLinks(): void {
      const rows = this.ctx.storage.sql.exec("SELECT target_type, target_id, link_name FROM active_links").toArray();

      if (rows.length === 0) return;

      const calls = rows.map((row) => {
        const link = ActiveLinkRowSchema.parse(row);
        return { name: link.link_name, id: link.target_id };
      });

      // Fire-and-forget re-registration
      this.registerSubscriptions(calls);
    }

    async spawn(input: {
      actorId?: string;
      caller: string;
      callerType: "user" | "service";
      input: unknown;
    }): Promise<void> {
      await this.loadState();
      if (this.initialized) {
        // Already initialized (auto-spawn or prior spawn call).
        if (input.actorId) this.rename(input.actorId);
        return;
      }

      // Validate input
      const parsed = def.input.safeParse(input.input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }

      // Store actor ID for JWT validation
      this.actorId = input.actorId ?? this.ctx.id.toString();

      // Create initial state with link support
      const initLinks: Array<{ name: string; id: string }> = [];
      const live = createLiveFacts();
      const link = async (name: string, id: string): Promise<unknown> => {
        const view = await this.linkedView(name, id);
        // Record the link for persistence, and the view as a fact for replay
        initLinks.push({ name, id });
        live.recordLinkView(name, id, view);
        return view;
      };

      const init = await stepInit(
        def,
        { input: parsed.data, caller: input.caller, callerType: input.callerType },
        liveStepFacts(live, () => []),
        { env: this.handlerEnv, link },
      );

      // Persist state + init links atomically
      this.pendingCause = { type: "init" };
      this.commit(init.state, init.event, () => {
        for (const { name, id } of initLinks) this.insertLink(name, id, "INSERT OR REPLACE");
      });
      this.initialized = true;

      // Register subscriptions for init links (fire-and-forget)
      if (initLinks.length > 0) {
        this.registerSubscriptions(initLinks);
      }
    }

    /**
     * A human-readable name for an actor known only by its hex ID (auto-spawned, or spawned again
     * with a name): store it and re-key the registry row, bypassing the touch debounce.
     */
    rename(actorId: string): void {
      if (this.actorId === actorId) return;
      const previousActorId = this.actorId ?? this.ctx.id.toString();
      this.actorId = actorId;
      this.ctx.storage.sql.exec("UPDATE snapshots SET actor_id = ? WHERE id = 1", this.actorId);
      this.lastRegistryTouch = 0;
      this.touchRegistry(previousActorId);
    }

    /** init()'s link(): the target's current view, with its role as a discriminant. */
    async linkedView(name: string, id: string): Promise<Record<string, unknown>> {
      const linkDef = def.links?.[name];
      if (!linkDef) throw new Error(`Link "${name}" not declared in actor definition`);

      const getSnapshot = rpcMethod(resolveStub(linkDef.contract.name, id, this.ctx, this.env), "getSnapshot");
      if (getSnapshot === null) {
        throw new Error(`Link "${name}": target actor unreachable`);
      }
      const result = LinkedSnapshotSchema.parse(await getSnapshot("system", "service"));
      return { role: result.role, ...result.snapshot };
    }

    /**
     * Deliver a message. `delivery` is set when another actor's forward sends it (ADR-016 §1): the
     * handler reads it as ctx.delivery. It is parsed here, at the RPC boundary.
     */
    async send(
      caller: string,
      callerType: "user" | "service",
      event: { type: string; [key: string]: unknown },
      delivery?: unknown,
    ): Promise<{ ok: boolean; error?: string; detail?: string }> {
      const forwarded = DeliveryInfoSchema.optional().safeParse(delivery);
      if (!forwarded.success) return { ok: false, error: "invalid_delivery", detail: forwarded.error.message };
      await this.loadState();
      const admitted = this.admit(caller, callerType, event);
      if (!admitted.ok) return admitted;
      this.applyMessage(event, admitted.role, admitted.payload, { caller, callerType }, forwarded.data);
      return { ok: true };
    }

    /** Whether the actor takes this message from this caller: its role, and the parsed payload. */
    admit(
      caller: string,
      callerType: "user" | "service",
      event: { type: string; [key: string]: unknown },
    ): { ok: true; role: string; payload: unknown } | { ok: false; error: string; detail?: string } {
      if (!this.initialized) {
        return { ok: false, error: "Actor not initialized" };
      }

      // Resolve role
      const role = resolveRole(def.roles, this.state, caller, { callerType });
      if (role === null) {
        return { ok: false, error: "No role matched" };
      }

      // Get messages
      if (def.messages === undefined) {
        return { ok: false, error: "No messages available" };
      }

      // Admit (validate payload, run guard); the transition runs through the step core in applyMessage().
      const admission = admitMessage(def.messages, role, this.state, event, {
        caller,
        callerType,
        env: this.handlerEnv,
      });
      if (!admission.ok) return rejected(admission);
      return { ok: true, role, payload: admission.payload };
    }

    /** Run an admitted message through the step core and commit it with its effects. */
    applyMessage(
      event: { type: string; [key: string]: unknown },
      role: string,
      payload: unknown,
      { caller, callerType }: { caller: string; callerType: "user" | "service" },
      delivery: DeliveryInfo | undefined,
    ): void {
      const result = this.runStep({ type: "message", name: event.type, payload, caller, callerType, role, delivery });

      // Timeline: record message cause
      const { type: _msgType, ...msgPayload } = event;
      this.pendingCause = {
        type: "message",
        messageType: event.type,
        caller,
        callerType,
        role,
        payload: msgPayload,
      };

      // onTransition sees the handler's state, before onUnlink
      this.observeTransition(result.handlerState, event, caller, role);

      // Persist state + executions + link intents + forwards + journal event atomically.
      this.commit(result.state, result.event, (seq) => this.writeEffects(result, seq, caller, callerType));

      // Studio: links may have changed. Then views, executions and forwards.
      if (result.effects.getLinks().length > 0 || result.effects.getUnlinks().length > 0) {
        this.pushStudioLinks();
      }
      this.afterEffects(result);
    }

    observeTransition(handlerState: unknown, event: { type: string }, caller: string, role: string): void {
      try {
        def.observe?.onTransition?.(this.state, handlerState, event, { caller, role });
      } catch {
        // Observability hooks must not break the transition
      }
    }

    async getSnapshot(
      caller: string,
      callerType: "user" | "service",
    ): Promise<{ checksum: string; snapshot: unknown; role: string }> {
      await this.loadState();
      if (!this.initialized) {
        throw new Error("Actor requires input — call spawn({ input }) before connecting");
      }

      const role = resolveRole(def.roles, this.state, caller, { callerType });
      if (role === null) {
        throw new Error("No role matched");
      }

      const viewDef = def.views[role];
      if (viewDef === undefined) {
        throw new Error(`No view for role "${role}"`);
      }

      const snapshot = viewDef.fn(this.state, caller);
      const json = JSON.stringify(snapshot);
      const checksum = this.computeChecksum(json);

      return { checksum, snapshot, role };
    }

    /** Check if a WebSocket is a studio connection (from in-memory set or tags). */
    isStudioWs(ws: WebSocket): boolean {
      if (this.studioConnections.has(ws)) return true;
      // Check tags for hibernation recovery
      if (isStudioSocket(this.ctx.getTags(ws))) {
        this.studioConnections.add(ws); // Re-populate after hibernation
        return true;
      }
      return false;
    }

    /** True if any studio WebSocket is currently attached, including hibernated ones. */
    hasStudioWs(): boolean {
      if (this.studioConnections.size > 0) return true;
      for (const ws of this.ctx.getWebSockets()) {
        if (this.isStudioWs(ws)) return true;
      }
      return false;
    }

    getCallerFromWs(ws: WebSocket): { caller: string; callerType: "user" | "service" } | null {
      // Try in-memory map first (keyed by WebSocket)
      const conn = this.connections.get(ws);
      if (conn) return conn;

      // Fall back to DO tags (survives hibernation)
      const tags = this.ctx.getTags(ws);
      const callerTag = tags.find((t: string) => t.startsWith("caller:"));
      const typeTag = tags.find((t: string) => t.startsWith("callerType:"));
      if (!callerTag || !typeTag) return null;
      const caller = callerTag.slice("caller:".length);
      const callerType = typeTag.slice("callerType:".length);
      if (callerType !== "user" && callerType !== "service") return null;
      // Re-populate in-memory maps (restore after hibernation)
      this.connections.set(ws, { caller, callerType });
      this.supportsBinary.set(ws, tags.includes("binary"));
      return { caller, callerType };
    }

    broadcastViews(): void {
      // Use getWebSockets() to get all connected sockets (survives hibernation)
      for (const ws of this.ctx.getWebSockets()) {
        // Skip studio connections — they don't receive view projections
        if (this.isStudioWs(ws)) continue;
        const info = this.getCallerFromWs(ws);
        if (!info) continue;
        try {
          this.pushView(ws, info.caller, info.callerType);
        } catch {
          // Connection may have closed
        }
      }

      // Push to DO subscribers (source-side)
      this.pushToSubscribers();
    }

    /** Send one socket its view if it changed (role included: a role change with identical data still sends). */
    pushView(ws: WebSocket, caller: string, callerType: "user" | "service"): void {
      const role = resolveRole(def.roles, this.state, caller, { callerType });
      if (role === null) return;
      const viewDef = def.views[role];
      if (viewDef === undefined) return;

      const viewData = viewDef.fn(this.state, caller);
      const previousKey = this.previousViews.get(ws);
      if (`${role}:${JSON.stringify(viewData)}` === previousKey) return;

      const previous = this.rememberView(ws, role, previousKey, viewData);
      ws.send(this.viewFrame(ws, viewDef, role, viewData, previous));
    }

    async fetch(request: Request): Promise<Response> {
      // --- Caller identity resolution (Worker-trust model) ---
      // The Worker authenticates the caller and stamps identity via withCallerIdentity().
      // SECURITY: withCallerIdentity scrubs inbound headers before setting verified ones.
      // Workers MUST call withCallerIdentity() before forwarding to the DO — forwarding
      // raw client requests (stub.fetch(request)) allows header spoofing.
      // CORS/Origin validation is handled at the Worker level (e.g., Hono cors() middleware).
      if (this.envError !== null) return new Response(this.envError, { status: 500 });
      const connect = parseConnectRequest(request);
      if (!connect.ok) return new Response(connect.message, { status: connect.status });

      await this.loadState();
      if (!this.initialized) {
        return new Response("Actor requires input — call spawn({ input }) before connecting", { status: 404 });
      }

      // Studio WebSocket — bypass role evaluation entirely.
      if (connect.caller === STUDIO_CALLER_ID) return this.connectStudio(request, connect.callerType);

      const role = resolveRole(def.roles, this.state, connect.caller, { callerType: connect.callerType });
      if (role === null) {
        return new Response("Forbidden", { status: 403 });
      }

      const client = this.acceptAppSocket(connect, role);
      this.runConnectLifecycle(connect.caller, connect.callerType, role);

      // The browser rejects the upgrade unless the server acknowledges one of the protocols the
      // client requested (the Actor Kit client always offers "actor-kit.v1").
      const headers: Record<string, string> =
        connect.protocol === null ? {} : { "Sec-WebSocket-Protocol": connect.protocol };
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    /** The reserved Studio caller ID is only honoured for service callers (the studio middleware stamps "service"). */
    connectStudio(request: Request, callerType: "user" | "service"): Response {
      if (callerType !== "service") {
        return new Response(`Caller ID "${STUDIO_CALLER_ID}" is reserved`, { status: 403 });
      }
      if (!this.studioEnabled) {
        return new Response("Studio is not enabled for this actor", { status: 404 });
      }
      return this.handleStudioWebSocket(request);
    }

    /** Accept an app socket for `role`: tags, attachment, Studio and registry notices, first snapshot. */
    acceptAppSocket(connect: Extract<ConnectRequest, { ok: true }>, role: string): WebSocket {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Store caller metadata as WebSocket tags so they survive DO hibernation.
      // Tags: ["caller:{id}", "callerType:{type}", "binary"?]
      const identityTags = [`caller:${connect.caller}`, `callerType:${connect.callerType}`];
      const tags = connect.binary ? [...identityTags, "binary"] : identityTags;
      const seq = nextConnectionSeq(this.socketRecords());
      this.ctx.acceptWebSocket(server, tags);
      this.connections.set(server, { caller: connect.caller, callerType: connect.callerType });

      // Per-socket identity for Studio: survives hibernation with the socket and
      // disappears with it on restart, and tells two tabs of one caller apart.
      const connectedAt = Date.now();
      const connectionId = crypto.randomUUID();
      server.serializeAttachment({ connectionId, connectedAt, seq });

      // Notify studio of new connection (covers hibernated sockets too)
      if (this.hasStudioWs()) {
        this.broadcastToStudio(async (projection) => ({
          type: "studio.connection",
          action: "connect",
          connection: {
            connectionId,
            caller: await projectCaller(connect.caller, projection),
            callerType: connect.callerType,
            connectedAt,
            role,
          },
        }));
      }

      // An app client connecting is real activity: register/touch the actor (debounced) so actors
      // persisted before the registry knew them still appear, then update the connection count.
      // (Studio sockets never reach this path, so a studio lookup never registers an actor.)
      this.touchRegistry();
      this.updateRegistryConnections();
      this.supportsBinary.set(server, connect.binary);

      this.sendFirstView(server, role, connect.caller);
      return client;
    }

    /** The first snapshot on a new socket: binary when the view has a schema and the client decodes it. */
    sendFirstView(ws: WebSocket, role: string, caller: string): void {
      const viewDef = def.views[role];
      if (!viewDef) return;
      const viewData = viewDef.fn(this.state, caller);
      this.rememberView(ws, role, undefined, viewData);
      ws.send(this.viewFrame(ws, viewDef, role, viewData, undefined));
    }

    runConnectLifecycle(caller: string, callerType: "user" | "service", role: string): void {
      if (!def.lifecycle?.connect) return;
      const result = this.runStep({
        type: "lifecycle.connect",
        caller,
        callerType,
        callerConnections: this.callerConnectionCount(caller, callerType),
        role,
      });
      this.commitLifecycle(result, { type: "lifecycle.connect", caller, callerType, role }, caller, callerType);
    }

    /**
     * Commit a lifecycle transition when it did something: changed the state or declared effects
     * (executions, forwards, timer schedules or cancels).
     */
    commitLifecycle(result: StepResult, cause: MutationCause, caller: string, callerType: "user" | "service"): void {
      if (result.state === this.state && !declaresEffects(result)) return;
      this.pendingCause = cause;
      this.commit(result.state, result.event, (seq) => this.writeEffects(result, seq, caller, callerType));
      this.afterEffects(result);
    }

    /**
     * Record what a socket was last sent: the dedupe key (role + JSON), the data deltas are computed
     * against, and the checksum a reconnect compares. Returns the data to delta against, or
     * undefined when there is none or the role changed (the client holds another schema's snapshot).
     */
    rememberView(
      ws: WebSocket,
      role: string,
      previousKey: string | undefined,
      viewData: unknown,
    ): Record<string, unknown> | undefined {
      const previousRole = previousKey?.split(":")[0];
      const roleChanged = previousRole !== undefined && previousRole !== role;
      const previous = roleChanged ? undefined : this.previousViewData.get(ws);
      const json = JSON.stringify(viewData);
      this.previousViews.set(ws, `${role}:${json}`);
      this.previousViewData.set(ws, viewData as Record<string, unknown>);
      this.connectionChecksums.set(ws, this.computeChecksum(json));
      return previous;
    }

    /** A view as a frame for one socket: a delta against `previous` when possible, else a snapshot. */
    viewFrame(
      ws: WebSocket,
      viewDef: ActorDef["views"][string],
      role: string,
      viewData: unknown,
      previous: Record<string, unknown> | undefined,
    ): string | Uint8Array {
      const viewSchema = viewDef.schema;
      if (!viewSchema?.fields || !(this.supportsBinary.get(ws) ?? false)) {
        // JSON fallback (no schema or connection doesn't support binary)
        return JSON.stringify({ type: "snapshot", role, data: viewData });
      }
      const schemaDef = viewSchema as SchemaDefinition<Record<string, FieldDescriptor>>;
      const deltaPayload = previous ? encodeDelta(schemaDef, previous, viewData as Record<string, unknown>) : null;
      if (deltaPayload) return createDeltaFrame(this.version, deltaPayload);
      // Full snapshot (first connect, role changed, or no delta)
      const payload = encode(schemaDef, viewData as Record<string, unknown>);
      return createSnapshotFrame(this.version, Object.keys(def.roles).indexOf(role), payload);
    }

    async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
      if (typeof data !== "string") return;

      // Studio connections: handle view requests, not app messages
      if (this.isStudioWs(ws)) {
        this.handleStudioMessage(ws, data);
        return;
      }

      const info = this.getCallerFromWs(ws);
      if (!info) return;

      try {
        await this.handleAppMessage(ws, info.caller, info.callerType, data);
      } catch {
        ws.send(JSON.stringify({ type: "__error", detail: "Invalid message" }));
      }
    }

    async handleAppMessage(ws: WebSocket, caller: string, callerType: "user" | "service", data: string): Promise<void> {
      // Parse at the boundary: validate the message has at minimum a type field
      const parsed = MessageEnvelopeSchema.safeParse(JSON.parse(data));
      if (!parsed.success) {
        ws.send(JSON.stringify({ type: "__error", detail: "Message must have a string 'type' field" }));
        return;
      }
      const event = parsed.data;

      // Handle reconnect handshake
      const lastChecksum = event["lastChecksum"];
      if (event.type === "__reconnect" && typeof lastChecksum === "string") {
        await this.handleReconnect(ws, caller, callerType, lastChecksum);
        return;
      }

      const result = await this.send(caller, callerType, event);
      // Send error frame back to client if message was rejected
      if (!result.ok) ws.send(JSON.stringify(rejectionFrame(event.type, result)));
    }

    async handleReconnect(
      ws: WebSocket,
      caller: string,
      callerType: "user" | "service",
      lastChecksum: string,
    ): Promise<void> {
      const role = resolveRole(def.roles, this.state, caller, { callerType });
      if (role === null) return;

      const viewDef = def.views[role];
      if (!viewDef) return;

      const viewData = viewDef.fn(this.state, caller);
      const currentChecksum = this.computeChecksum(JSON.stringify(viewData));

      if (currentChecksum === lastChecksum) {
        // State hasn't changed — send ack, no data needed
        ws.send(JSON.stringify({ type: "__reconnect_ack", checksum: currentChecksum }));
        return;
      }
      // State changed — send full snapshot (we don't have the client's previous view)
      this.previousViewData.set(ws, viewData as Record<string, unknown>);
      this.connectionChecksums.set(ws, currentChecksum);
      ws.send(this.viewFrame(ws, viewDef, role, viewData, undefined));
    }

    async webSocketClose(ws: WebSocket, code?: number, reason?: string): Promise<void> {
      // Answer the peer's close frame. Without web_socket_auto_reply_to_close
      // the runtime does not, and the browser socket stays CLOSING forever.
      answerClose(ws, code, reason);

      // Studio connections — just clean up, no lifecycle
      if (this.isStudioWs(ws)) {
        this.studioConnections.delete(ws);
        return;
      }

      const info = this.getCallerFromWs(ws);
      if (!info) return;

      this.forgetSocket(ws);
      this.announceDisconnect(ws, info.caller, info.callerType);
      // Update registry connection count (the closing socket may still be listed)
      this.updateRegistryConnections(ws);
      this.runDisconnectLifecycle(ws, info.caller, info.callerType);
    }

    forgetSocket(ws: WebSocket): void {
      this.connections.delete(ws);
      this.previousViews.delete(ws);
      this.previousViewData.delete(ws);
      this.connectionChecksums.delete(ws);
      this.supportsBinary.delete(ws);
    }

    /** Notify studio of a disconnection (covers hibernated sockets too). */
    announceDisconnect(ws: WebSocket, caller: string, callerType: "user" | "service"): void {
      const attachment = readConnectionAttachment(ws.deserializeAttachment());
      if (attachment === null || !this.hasStudioWs()) return;
      const { connectionId } = attachment;
      this.broadcastToStudio(async (projection) => ({
        type: "studio.connection",
        action: "disconnect",
        connection: { connectionId, caller: await projectCaller(caller, projection), callerType },
      }));
    }

    runDisconnectLifecycle(ws: WebSocket, caller: string, callerType: "user" | "service"): void {
      if (!def.lifecycle?.disconnect) return;
      const result = this.runStep({
        type: "lifecycle.disconnect",
        caller,
        callerType,
        callerConnections: this.callerConnectionCount(caller, callerType, ws),
        role: null,
      });
      const role = result.event.role ?? "unknown";
      this.commitLifecycle(result, { type: "lifecycle.disconnect", caller, callerType, role }, caller, callerType);
    }

    // --- Studio WebSocket handling ---

    /** Handle a studio WebSocket connection — bypasses roles, sends full state + timeline. */
    handleStudioWebSocket(request: Request): Response {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // The viewer (stamped by the studio middleware) is kept as a tag so it survives hibernation.
      const viewer = viewerFromHeader(request.headers.get(STUDIO_VIEWER_HEADER));
      const tags = [`caller:${STUDIO_CALLER_ID}`, "callerType:service", ...viewerTags(viewer)];
      this.ctx.acceptWebSocket(server, tags);
      this.studioConnections.add(server);

      // Initial snapshot: read now, projected and sent in order with any later pushes.
      const snapshot = this.readStudioSnapshot();
      this.enqueueStudioSend(server, async () => await this.projectStudioSnapshot(snapshot, viewer));

      const reqProtocolHeader = request.headers.get("Sec-WebSocket-Protocol");
      const requestedProtocols = reqProtocolHeader?.split(",").map((p) => p.trim()) ?? [];
      const responseProtocol = requestedProtocols.includes("actor-kit.v1") ? "actor-kit.v1" : null;
      const responseHeaders: Record<string, string> = {};
      if (responseProtocol !== null) {
        responseHeaders["Sec-WebSocket-Protocol"] = responseProtocol;
      }

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders,
      });
    }

    /** What Studio may see, for this viewer (ADR-014). Agents need STUDIO_CALLER_HASH_KEY. */
    studioProjection(viewer: StudioViewer): StudioProjection {
      if (viewer === "human") return { redactor: studioRedactor, hashCaller: null };
      if (this.callerHasher === null) {
        const key = this.envBindings["STUDIO_CALLER_HASH_KEY"];
        if (typeof key !== "string" || key === "") {
          throw new Error("STUDIO_CALLER_HASH_KEY is not set: agents cannot use Studio");
        }
        this.callerHasher = createCallerHasher(key);
      }
      return { redactor: studioRedactor, hashCaller: this.callerHasher };
    }

    /** Raw outbox rows (payloads unredacted — project before returning them to Studio). */
    readOutbox(): StudioOutboxRow[] {
      return readOutboxRows(this.ctx.storage.sql);
    }

    readActiveLinks(): Array<{ targetType: string; targetId: string; linkName: string; version: number }> {
      return this.ctx.storage.sql
        .exec("SELECT target_type, target_id, link_name, version FROM active_links")
        .toArray()
        .map((row) => ({
          targetType: String(row["target_type"]),
          targetId: String(row["target_id"]),
          linkName: String(row["link_name"]),
          version: Number(row["version"]),
        }));
    }

    readLinkSubscribers(): Array<{ subscriberType: string; subscriberId: string }> {
      return this.ctx.storage.sql
        .exec("SELECT subscriber_type, subscriber_id FROM link_subscribers")
        .toArray()
        .map((row) => ({
          subscriberType: String(row["subscriber_type"]),
          subscriberId: String(row["subscriber_id"]),
        }));
    }

    /** Read the raw studio snapshot synchronously (state as of now). */
    readStudioSnapshot() {
      const timeline = this.ctx.storage.sql
        .exec(
          "SELECT id, cause_type, cause_data, state_snapshot, checksum, created_at, seq FROM timeline ORDER BY id DESC LIMIT 50",
        )
        .toArray()
        .map(toTimelineEntry);
      return {
        state: this.state,
        timeline,
        connections: this.liveConnections(),
        outbox: this.readOutbox(),
        timers: readTimers(this.ctx.storage.sql),
        activeLinks: this.readActiveLinks(),
        linkSubscribers: this.readLinkSubscribers(),
        actorId: this.actorId ?? this.ctx.id.toString(),
        version: this.version,
      };
    }

    /** Project a raw snapshot for one viewer: the initial studio.snapshot frame. */
    async projectStudioSnapshot(
      snapshot: ReturnType<ActorInstance["readStudioSnapshot"]>,
      viewer: StudioViewer,
    ): Promise<Record<string, unknown>> {
      const projection = this.studioProjection(viewer);
      return {
        type: "studio.snapshot",
        state: projectState(snapshot.state, projection),
        timeline: await Promise.all(snapshot.timeline.map((e) => projectTimelineEntry(e, projection))),
        connections: await projectConnections(snapshot.connections, projection),
        outbox: snapshot.outbox.map((row) => projectOutboxRow(row, projection)),
        timers: snapshot.timers.map((row) => projectTimerRow(row, projection)),
        activeLinks: snapshot.activeLinks,
        linkSubscribers: snapshot.linkSubscribers,
        actorType: _actorName,
        actorId: snapshot.actorId,
        version: snapshot.version,
      };
    }

    /** Push the whole outbox to studio sockets after an execution is added or settles. */
    pushStudioOutbox(): void {
      if (!this.hasStudioWs()) return;
      const outbox = this.readOutbox();
      this.broadcastToStudio(async (projection) => ({
        type: "studio.outbox",
        outbox: outbox.map((row) => projectOutboxRow(row, projection)),
      }));
    }

    /** Push the pending timers to studio sockets after a commit schedules, cancels or fires one. */
    pushStudioTimers(): void {
      if (!this.hasStudioWs()) return;
      const timers = readTimers(this.ctx.storage.sql);
      this.broadcastToStudio(async (projection) => ({
        type: "studio.timers",
        timers: timers.map((row) => projectTimerRow(row, projection)),
      }));
    }

    /** Push links + subscribers to studio sockets after either table changes. */
    pushStudioLinks(): void {
      if (!this.hasStudioWs()) return;
      const activeLinks = this.readActiveLinks();
      const linkSubscribers = this.readLinkSubscribers();
      this.broadcastToStudio(async () => ({ type: "studio.links", activeLinks, linkSubscribers }));
    }

    /** Handle a frame from a studio WebSocket: view requests only; app messages are refused. */
    handleStudioMessage(ws: WebSocket, data: string): void {
      const reply = handleStudioFrame(data, { views: def.views, roles: def.roles, state: this.state });
      const viewer = viewerFromTags(this.ctx.getTags(ws));
      this.enqueueStudioSend(ws, async () =>
        reply.type === "studio.view" ? await projectView(reply, this.studioProjection(viewer)) : reply,
      );
    }

    /**
     * Send one studio frame, built asynchronously, after every frame queued before it.
     * A frame that cannot be projected (e.g. an agent socket without STUDIO_CALLER_HASH_KEY)
     * is never sent raw: the socket gets a studio.error instead.
     */
    enqueueStudioSend(ws: WebSocket, build: () => Promise<Record<string, unknown>>): void {
      this.studioSendChain = this.studioSendChain.then(async () => {
        let frame: Record<string, unknown>;
        try {
          frame = await build();
        } catch (error) {
          frame = { type: "studio.error", error: error instanceof Error ? error.message : String(error) };
        }
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          this.studioConnections.delete(ws);
        }
      });
    }

    /** Throws when studio instrumentation is off — every studio RPC entry point calls this. */
    assertStudioEnabled(): void {
      if (!this.studioEnabled) {
        throw new Error("Studio is not enabled for this actor");
      }
    }

    /** Send a frame to all connected studio WebSockets, projected per viewer (built once per viewer kind).
     * Iterates ctx.getWebSockets() so it survives DO hibernation —
     * the in-memory studioConnections set is repopulated lazily by isStudioWs(). */
    broadcastToStudio(build: (projection: StudioProjection) => Promise<Record<string, unknown>>): void {
      const built = new Map<StudioViewer, Promise<Record<string, unknown>>>();
      const frameFor = (viewer: StudioViewer) => {
        let frame = built.get(viewer);
        if (frame === undefined) {
          frame = Promise.resolve().then(() => build(this.studioProjection(viewer)));
          built.set(viewer, frame);
        }
        return frame;
      };
      for (const ws of this.ctx.getWebSockets()) {
        if (!this.isStudioWs(ws)) continue;
        const viewer = viewerFromTags(this.ctx.getTags(ws));
        this.enqueueStudioSend(ws, () => frameFor(viewer));
      }
    }

    // --- Studio RPC methods ---

    /** Studio RPC: returns current state + metadata for inspection, redacted (ADR-014).
     * `viewer: "agent"` also hashes callers. */
    __inspect(opts?: { viewer?: StudioViewer }): Promise<{
      /** false when no actor has ever been persisted under this ID (studio lookups never create one). */
      initialized: boolean;
      state: unknown;
      version: number;
      actorId: string | null;
      connections: LiveConnection[];
      outbox: StudioOutboxRow[];
      /** Pending timers (ADR-015 D2). Absent for an actor that does not exist. */
      timers?: TimerRow[];
      activeLinks: Array<{
        targetType: string;
        targetId: string;
        linkName: string;
        version: number;
      }>;
      linkSubscribers: Array<{
        subscriberType: string;
        subscriberId: string;
      }>;
    }> {
      // Studio lookups are read-only: never auto-spawn, persist or register an actor.
      this.loadPersisted({ create: false });
      this.assertStudioEnabled();
      // Validation and projection setup throw synchronously, as before (RPC rejects either way).
      const projection = this.studioProjection(parseInspectOptions(opts).viewer);

      if (!this.persistedLoaded) {
        // No actor has ever been persisted under this ID.
        return Promise.resolve({
          initialized: false,
          state: null,
          version: this.version,
          actorId: null,
          connections: [],
          outbox: [],
          activeLinks: [],
          linkSubscribers: [],
        });
      }

      const base = {
        initialized: this.initialized,
        state: projectState(this.state, projection),
        version: this.version,
        actorId: this.actorId ?? null,
        outbox: this.readOutbox().map((row) => projectOutboxRow(row, projection)),
        timers: readTimers(this.ctx.storage.sql).map((row) => projectTimerRow(row, projection)),
        activeLinks: this.readActiveLinks(),
        linkSubscribers: this.readLinkSubscribers(),
      };
      return projectConnections(this.liveConnections(), projection).then((connections) => ({ ...base, connections }));
    }

    /** Studio RPC: returns paginated timeline entries, newest first, redacted (ADR-014).
     * `before` is an exclusive entry-ID cursor; IDs are unique, so equal timestamps
     * never cause gaps or duplicates at page boundaries. Invalid options are rejected. */
    __getTimeline(opts?: { limit?: number; before?: number; viewer?: StudioViewer }): Promise<{
      entries: StudioTimelineEntry[];
      hasMore: boolean;
    }> {
      // Studio lookups are read-only: never auto-spawn, persist or register an actor.
      this.loadPersisted({ create: false });
      this.assertStudioEnabled();
      const { limit, before, viewer } = parseTimelineOptions(opts);
      const projection = this.studioProjection(viewer ?? "human");
      if (!this.persistedLoaded) return Promise.resolve({ entries: [], hasMore: false });

      const rows =
        before !== undefined
          ? this.ctx.storage.sql
              .exec(
                "SELECT id, cause_type, cause_data, state_snapshot, checksum, created_at, seq FROM timeline WHERE id < ? ORDER BY id DESC LIMIT ?",
                before,
                limit + 1,
              )
              .toArray()
          : this.ctx.storage.sql
              .exec(
                "SELECT id, cause_type, cause_data, state_snapshot, checksum, created_at, seq FROM timeline ORDER BY id DESC LIMIT ?",
                limit + 1,
              )
              .toArray();

      const hasMore = rows.length > limit;
      const raw = rows.slice(0, limit).map(toTimelineEntry);
      return Promise.all(raw.map((entry) => projectTimelineEntry(entry, projection))).then((entries) => ({
        entries,
        hasMore,
      }));
    }

    /**
     * Studio RPC (mutate scope, ADR-014): move a dead letter (`failed` execution) back to `pending`
     * under the same effect id, then run it. Any other row, or an unknown id, is refused.
     */
    __redrive(opts: { effectId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
      // Like the other studio RPCs, refusals throw synchronously (an async throw is reported by
      // workerd as an unhandled rejection even though the RPC caller receives it).
      this.loadPersisted({ create: false });
      this.assertStudioEnabled();
      const { effectId } = RedriveOptionsSchema.parse(opts);
      if (!this.persistedLoaded) return Promise.resolve({ ok: false, error: "Actor not found" });
      const sql = this.ctx.storage.sql;
      if (!redriveExecution(sql, effectId) && !redriveExecution(sql, effectId, "forwards")) {
        return Promise.resolve({ ok: false, error: `Effect ${effectId} is not a failed execution` });
      }
      // A try of the dead letter still in flight (a restore cancelled it while it ran) is aborted: its
      // result must not settle the redriven row.
      this.inFlight.abort("executions", effectId, "redriven");
      this.inFlight.abort("forwards", effectId, "redriven");
      this.pushStudioOutbox();
      void this.drainExecutions();
      void this.drainForwards();
      return Promise.resolve({ ok: true });
    }

    /**
     * Studio RPC (mutate scope, ADR-014): fire a pending timer now, by key, exactly as alarm()
     * would (its own transaction and journal event; lateBy 0 when early). Unknown keys are refused.
     */
    __fireTimer(opts: { key: string }): Promise<{ ok: true } | { ok: false; error: string }> {
      this.loadPersisted({ create: false });
      this.assertStudioEnabled();
      const { key } = FireTimerOptionsSchema.parse(opts);
      if (!this.persistedLoaded) return Promise.resolve({ ok: false, error: "Actor not found" });
      const due = timerByKey(this.ctx.storage.sql, key);
      if (due === null) return Promise.resolve({ ok: false, error: `No pending timer with key "${key}"` });
      this.fireTimer(due, Date.now());
      this.syncAlarm();
      return Promise.resolve({ ok: true });
    }

    /**
     * Studio RPC (mutate scope, ADR-014): restore the actor to journal seq `toSeq` (ADR-015 D3).
     * Appends a `restore` event (history is kept), puts back the state and the timers pending at
     * toSeq, fails effects only undone transitions declared, and redelivers service results
     * recorded after toSeq as new events, without calling any service again.
     */
    __restore(opts: { toSeq: number }): Promise<{ ok: true } | { ok: false; error: string }> {
      this.loadPersisted({ create: false });
      this.assertStudioEnabled();
      const { toSeq } = RestoreOptionsSchema.parse(opts);
      if (!this.persistedLoaded) return Promise.resolve({ ok: false, error: "Actor not found" });
      if (!journalConfig.enabled)
        return Promise.resolve({ ok: false, error: "Restore needs the journal (journal: false)" });
      return this.restoreTo(toSeq);
    }

    async restoreTo(toSeq: number): Promise<{ ok: true } | { ok: false; error: string }> {
      const sql = this.ctx.storage.sql;
      let plan: Awaited<ReturnType<typeof planRestore>>;
      try {
        plan = await planRestore(def, readJournal(sql), toSeq, { env: this.handlerEnv });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      this.pendingCause = { type: "restore", toSeq };
      const draft: JournalDraft = {
        causeType: "restore",
        name: null,
        payload: { toSeq },
        caller: null,
        callerType: null,
        role: null,
        facts: {},
      };
      this.commit(plan.state, draft, () => {
        sql.exec("DELETE FROM timers");
        applyTimerOps(
          sql,
          plan.timers.map((timer) => ({ op: "schedule", ...timer })),
          Date.now(),
        );
        cancelUndoneEffects(sql, toSeq, `cancelled: the actor was restored to seq ${toSeq}`);
        this.inFlight.abortAfter(toSeq, `cancelled: the actor was restored to seq ${toSeq}`);
        this.timersChanged = true;
      });
      for (const recorded of plan.redeliver) this.redeliver(recorded);
      this.broadcastViews();
      this.pushStudioOutbox();
      return { ok: true };
    }

    /** Deliver a recorded service result again as a new event (the service is not called). */
    redeliver(recorded: JournalEvent): void {
      const payload = RecordedResultSchema.parse(recorded.payload);
      const service = recorded.name ?? "";
      const cause: StepCause =
        "result" in payload
          ? {
              type: "service.onDone",
              service,
              input: payload.input,
              result: payload.result,
              effectId: payload.effectId,
            }
          : {
              type: "service.onError",
              service,
              input: payload.input,
              error: payload.error,
              effectId: payload.effectId,
            };
      const result = this.runStep(cause);
      if (result.state === this.state) return;
      this.pendingCause =
        cause.type === "service.onDone"
          ? { type: cause.type, service, input: cause.input, result: cause.result }
          : { type: cause.type, service, input: cause.input, error: describeRecordedError(cause.error) };
      this.commit(result.state, result.event);
    }

    /** Studio RPC: one role's view, as `studio.requestView` would return it, redacted (ADR-014). */
    __getView(opts: {
      role: string;
      caller?: string;
      callerType?: "user" | "service";
      viewer?: StudioViewer;
    }): Promise<StudioViewReply> {
      // Studio lookups are read-only: never auto-spawn, persist or register an actor.
      this.loadPersisted({ create: false });
      this.assertStudioEnabled();
      const { viewer, ...request } = parseViewOptions(opts);
      const projection = this.studioProjection(viewer);
      if (!this.persistedLoaded) {
        return Promise.resolve({
          type: "studio.view",
          role: request.role,
          caller: request.caller ?? null,
          error: "Actor not found",
        });
      }
      return projectView(studioView(request, { views: def.views, roles: def.roles, state: this.state }), projection);
    }
  };

  // Stamp contract name for ctx.exports discovery (ADR-012)
  Object.defineProperty(DOClass, "__actorKitContractName", {
    value: _actorName,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return DOClass;
}

// --- createActorClass() ---

/**
 * Runtime type guard for ActorDef.
 * Validates that a definition has the required shape for the actor runtime.
 * This bridges the gap between the fully-typed contract (with concrete state types)
 * and the runtime interface (which uses bivariant unknown-typed signatures).
 */
function isActorDef(def: unknown): def is ActorDef {
  return hasActorDefShape(def);
}

/**
 * Detect whether messages are flat (v3: Record<name, MessageDef>) or
 * role-nested (v2: Record<role, Record<name, MessageDef>>).
 *
 * A flat MessageDef has both `schema` and `handler` as direct properties.
 * A role-nested Record's values are Records (no `handler`).
 * We check all entries to avoid false positives from role names like "schema".
 */
function isFlatMessages(messages: Record<string, unknown>): boolean {
  const values = Object.values(messages);
  if (values.length === 0) return false;
  return values.every((v) => typeof v === "object" && v !== null && "schema" in v && "handler" in v);
}

/**
 * Wrap flat messages into role-nested format: every role gets all messages.
 * Guards handle authorization instead of structural role-scoping.
 */
function wrapFlatMessages(
  flatMessages: Record<string, ActorMessageSlot>,
  roles: Record<string, unknown>,
): Record<string, Record<string, ActorMessageSlot>> {
  const roleNames = Object.keys(roles);
  const result: Record<string, Record<string, ActorMessageSlot>> = {};
  for (const role of roleNames) {
    result[role] = flatMessages;
  }
  return result;
}

// --- Type helpers for createActorClass return type ---

/** Extract event union from a contract's flat messages. */

/** Extract input type from a contract's Zod schema. */
type ContractInput<T> = T extends { def: { input: { _input: infer I } } } ? I : unknown;

/** Typed Durable Object class returned by createActorClass. */
export interface TypedActorClass<TContract> {
  new (
    ctx: DurableObjectState,
    env: Record<string, unknown>,
  ): DurableObject & {
    spawn(input: {
      actorId?: string;
      caller: string;
      callerType: "user" | "service";
      input: ContractInput<TContract>;
    }): Promise<void>;
    send(
      caller: string,
      callerType: "user" | "service",
      event: ContractMessages<TContract>,
      /** Set by a forward (ADR-016 §1): the target's handler reads it as ctx.delivery. */
      delivery?: DeliveryInfo,
    ): Promise<{ ok: boolean; error?: string }>;
    getSnapshot(
      caller: string,
      callerType: "user" | "service",
    ): Promise<{ checksum: string; snapshot: unknown; role: string }>;
    fetch(request: Request): Promise<Response>;
    __inspect(opts?: { viewer?: "human" | "agent" }): Promise<{
      /** false when no actor has ever been persisted under this ID (studio lookups never create one). */
      initialized: boolean;
      state: unknown;
      version: number;
      actorId: string | null;
      connections: LiveConnection[];
      outbox: Array<{
        id: string;
        service: string;
        payload: string;
        status: string;
        attempts: number;
        createdAt: number;
        nextAttemptAt: number | null;
        lastError: string | null;
      }>;
      timers?: Array<{ id: string; name: string; key: string; payload: string; fireAt: number; createdAt: number }>;
      activeLinks: Array<{
        targetType: string;
        targetId: string;
        linkName: string;
        version: number;
      }>;
      linkSubscribers: Array<{
        subscriberType: string;
        subscriberId: string;
      }>;
    }>;
    __getTimeline(opts?: { limit?: number; before?: number; viewer?: "human" | "agent" }): Promise<{
      entries: Array<{
        id: number;
        causeType: string;
        causeData: string;
        stateSnapshot: string;
        checksum: string;
        createdAt: number;
        seq?: number;
      }>;
      hasMore: boolean;
    }>;
    __redrive(opts: { effectId: string }): Promise<{ ok: true } | { ok: false; error: string }>;
    __fireTimer(opts: { key: string }): Promise<{ ok: true } | { ok: false; error: string }>;
    __restore(opts: { toSeq: number }): Promise<{ ok: true } | { ok: false; error: string }>;
    __getView(opts: {
      role: string;
      caller?: string;
      callerType?: "user" | "service";
      viewer?: "human" | "agent";
    }): Promise<
      | { type: "studio.view"; role: string; caller: string | null; error: string }
      | { type: "studio.view"; role: string; caller: string | null; callerRole: string | null; data: unknown }
    >;
  };
}

/**
 * Convert a typed contract (from defineActor) into a Durable Object class.
 *
 * The returned class has typed RPC methods:
 * - spawn({ input }) — input type from the contract's Zod schema
 * - send(caller, callerType, event) — event union from the contract's messages
 * - getSnapshot(caller, callerType) — returns snapshot + role
 * - fetch(request) — WebSocket upgrade handler
 *
 * Use with `wrangler types` to get typed bindings in your Worker's env:
 *   DurableObjectNamespace<CounterDO> → env.COUNTER.get(id).send() is typed
 *
 * Usage:
 *   const Counter = defineActor("counter", { init, roles, messages, views });
 *   export const CounterDO = createActorClass(Counter);
 */
export function createActorClass<TContract extends { readonly name: string; readonly def: unknown }>(
  contract: TContract,
): TypedActorClass<TContract> {
  if (!isActorDef(contract.def)) {
    throw new Error("createActorClass: contract.def must have init, roles, and views");
  }

  const def = contract.def;

  // Detect flat messages and wrap into role-nested format
  if (def.messages && isFlatMessages(def.messages)) {
    const wrapped = wrapFlatMessages(def.messages as unknown as Record<string, ActorMessageSlot>, def.roles);
    const adaptedDef: ActorDef = { ...def, messages: wrapped };
    // Internal boundary cast: actor() returns an untyped class, but the runtime class
    // implements spawn/send/getSnapshot/fetch. TypedActorClass exposes these to consumers.
    return actor(contract.name, adaptedDef) as unknown as TypedActorClass<TContract>;
  }

  return actor(contract.name, def) as unknown as TypedActorClass<TContract>;
}
