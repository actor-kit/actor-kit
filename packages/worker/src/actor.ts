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
import type { FieldDescriptor, MessageContext, MutationCause, SchemaDefinition } from "@actor-kit/core";
import { createDeltaFrame, createSnapshotFrame, encode, encodeDelta } from "@actor-kit/core";
import { DOQB } from "workers-qb";
import type { z } from "zod";
import { BINARY_SUPPORT_HEADER, CALLER_ID_HEADER, CALLER_TYPE_HEADER } from "./identity";
import { routeMessage } from "./runtime/message-router";
import { createOutbox } from "./runtime/outbox";
import { resolveNamespace } from "./runtime/resolve-namespace";
import { resolveRole } from "./runtime/roles";

// --- Studio registry helpers ---

/**
 * Runtime type guard for DurableObjectNamespace.
 * Used to detect StudioRegistry in env bindings without compile-time knowledge of the binding.
 */
function looksLikeDONamespace(val: unknown): boolean {
  if (typeof val !== "object" || val === null) return false;
  return "idFromName" in val && "get" in val;
}

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
  init(
    input: unknown,
    ctx: { env: unknown; link: (name: string, id: string) => Promise<unknown> },
  ): unknown | Promise<unknown>; // bivariant — optionally async, receives ctx
  version?: number;
  roles: Record<
    string,
    {
      // bivariant method signature for role predicates
      (state: unknown, caller: string, claims: { callerType: "user" | "service" }): boolean;
    }
  >;
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
    connect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
    disconnect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
  };
  observe?: {
    onTransition?(
      prevState: unknown,
      nextState: unknown,
      event: { type: string },
      ctx: { caller: string; role: string },
    ): void;
  };
  services?: Record<
    string,
    {
      fn(input: unknown, env: unknown): Promise<unknown>;
      onDone?(state: unknown, result: unknown, input: unknown): unknown;
      onError?(state: unknown, error: { message: string }, input: unknown): unknown;
    }
  >;
  links?: Record<
    string,
    {
      contract: { readonly name: string };
      onUpdate(state: unknown, view: unknown, id?: string): unknown;
      onError?: ((state: unknown, error: { message: string; code: string }, id?: string) => unknown) | undefined;
      onUnlink?: ((state: unknown, id?: string) => unknown) | undefined;
    }
  >;
  migrate?(persisted: unknown, fromVersion: number): unknown;
  serialize?(state: unknown): unknown;
  restore?(serialized: unknown): unknown;
  studio?: {
    /** Force-enable timeline recording regardless of ctx.exports detection. */
    enabled?: boolean;
    timelineSize?: number;
  };
}

// --- SQL migrations ---
// Tracked by workers-qb in _qb_migrations table.
// Append new migrations here — never edit existing ones.

const ACTOR_KIT_MIGRATIONS = [
  {
    name: "0001_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS actor_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER,
        state TEXT,
        state_tracker TEXT,
        actor_id TEXT,
        checksum TEXT,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        type TEXT,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER
      );
    `,
  },
  {
    name: "0002_outbox_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
    `,
  },
  {
    name: "0003_executions",
    sql: `
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status, created_at);
    `,
  },
  {
    name: "0004_links",
    sql: `
      CREATE TABLE IF NOT EXISTS active_links (
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        link_name TEXT NOT NULL,
        version INTEGER DEFAULT 0,
        created_at INTEGER,
        PRIMARY KEY (target_type, target_id, link_name)
      );
      CREATE TABLE IF NOT EXISTS link_subscribers (
        subscriber_type TEXT NOT NULL,
        subscriber_id TEXT NOT NULL,
        subscribed_at INTEGER,
        PRIMARY KEY (subscriber_type, subscriber_id)
      );
    `,
  },
  {
    name: "0005_forwards",
    sql: `
      CREATE TABLE IF NOT EXISTS forwards (
        id TEXT PRIMARY KEY,
        link_name TEXT NOT NULL,
        target_id TEXT NOT NULL,
        message TEXT NOT NULL,
        caller TEXT NOT NULL,
        caller_type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_forwards_status_created ON forwards(status, created_at);
    `,
  },
  {
    name: "0006_timeline",
    sql: `
      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cause_type TEXT NOT NULL,
        cause_data TEXT NOT NULL,
        state_snapshot TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline(created_at DESC);
    `,
  },
];

// --- Helpers ---

/**
 * Safely extract the `exports` map from a DurableObjectState ctx.
 * In multi-DO Workers, the CF runtime populates ctx.exports with co-located bindings.
 * We access it via unknown to avoid casting DurableObjectState.
 */
function getExports(ctx: unknown): Record<string, unknown> | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  if ("exports" in ctx) {
    const val: unknown = (ctx as Record<string, unknown>)["exports"];
    if (typeof val === "object" && val !== null) return val as Record<string, unknown>;
  }
  return undefined;
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
  def: ActorDef,
): { new (ctx: DurableObjectState, env: Record<string, unknown>): DurableObject } {
  const DOClass = class ActorInstance extends DurableObject {
    state: unknown = undefined;
    actorId: string | undefined = undefined; // Human-readable ID (the name passed to idFromName)
    initialized = false;
    version: number;
    /** env stored with index signature — the base DurableObject.env lacks it. */
    envBindings: Record<string, unknown>;
    // Keyed by WebSocket (not caller) to support multi-tab/multi-device
    connections = new Map<WebSocket, { caller: string; callerType: "user" | "service" }>();
    previousViews = new Map<WebSocket, string>(); // dedupe key: "role:json"
    previousViewData = new Map<WebSocket, Record<string, unknown>>(); // actual view data for delta computation
    connectionChecksums = new Map<WebSocket, string>(); // last checksum sent per connection
    supportsBinary = new Map<WebSocket, boolean>(); // per-connection binary capability
    drainingExecutions = false; // Prevents concurrent execution drains
    previousSubscriberViews = new Map<string, string>(); // dedupe: "type:id" → "role:json"

    // --- Timeline (studio instrumentation) ---
    studioEnabled = false; // Detected from ctx.exports on init
    pendingCause: MutationCause | null = null; // Set before persistState(), consumed by persistState()
    timelineSize = 500; // Ring buffer max entries
    studioConnections = new Set<WebSocket>(); // Studio WebSocket connections (separate from app connections)
    registryStub: DurableObjectStub | null = null; // Cached StudioRegistry stub for RPC
    lastRegistryTouch = 0; // Timestamp of last registry touch (for debouncing)

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.envBindings = env;
      this.version = def.version ?? 1;
      this.timelineSize = def.studio?.timelineSize ?? 500;
      // Load state before any requests are served.
      // blockConcurrencyWhile ensures no fetch/send/WebSocket during init.
      this.ctx.blockConcurrencyWhile(async () => {
        await this.loadState();
      });
    }

    runMigrations(): void {
      new DOQB(this.ctx.storage.sql).migrations({ migrations: ACTOR_KIT_MIGRATIONS }).apply();
    }

    async loadState(): Promise<void> {
      if (this.initialized) return;

      this.runMigrations();

      // Enable timeline instrumentation: always try to detect registry (for auto-registration),
      // then OR with explicit config flag
      const registryDetected = this.detectStudio();
      this.studioEnabled = registryDetected || def.studio?.enabled === true;

      const rows = this.ctx.storage.sql.exec("SELECT state, version, actor_id FROM snapshots WHERE id = 1").toArray();

      if (rows.length > 0 && rows[0] !== undefined) {
        const row = rows[0] as {
          state: string;
          version: number;
          actor_id: string | null;
        };
        let parsed: unknown = JSON.parse(row.state);

        // Run migration if needed
        if (def.migrate && row.version !== this.version) {
          parsed = def.migrate(parsed, row.version);
        }

        // Restore state
        this.state = def.restore ? def.restore(parsed) : parsed;

        // Restore actor ID
        if (row.actor_id !== null) {
          this.actorId = row.actor_id;
        }

        this.initialized = true;

        // Drain any pending executions from before crash/restart
        this.drainExecutions();

        // Drain any pending forwards from before crash/restart
        this.drainForwards();

        // Re-register active link subscriptions
        if (def.links) {
          this.reRegisterLinks();
        }
      } else {
        // No persisted state — try auto-spawn with empty input
        const emptyParsed = def.input.safeParse({});
        if (emptyParsed.success) {
          this.actorId = this.ctx.id.toString();
          this.state = await def.init(emptyParsed.data, {
            env: this.env,
            link: async () => {
              throw new Error("link() not available during auto-spawn");
            },
          });
          this.initialized = true;

          this.pendingCause = { type: "init" };
          this.persistState();
        }
        // If input requires fields, stay uninitialized — spawn() must be called explicitly
      }
    }

    /** Detect StudioRegistry in ctx.exports or env and cache the stub. */
    detectStudio(): boolean {
      // Try ctx.exports first (production with enable_ctx_exports)
      const exports = getExports(this.ctx);
      if (exports) {
        for (const [, val] of Object.entries(exports)) {
          if (typeof val === "object" && val !== null && "__actorKitStudioRegistry" in val) {
            const stub = resolveSingletonStub(val, "registry");
            if (stub) this.registryStub = stub;
            return true;
          }
        }
      }

      // Fall back to env.STUDIO_REGISTRY binding (works in wrangler dev)
      const registryBinding: unknown = this.envBindings["STUDIO_REGISTRY"];
      if (looksLikeDONamespace(registryBinding)) {
        const stub = resolveSingletonStub(registryBinding, "registry");
        if (stub) this.registryStub = stub;
        return true;
      }

      return false;
    }

    /** Fire-and-forget: touch the registry to update last_active_at (debounced 10s). */
    touchRegistry(): void {
      if (this.registryStub === null) return;
      const now = Date.now();
      if (now - this.lastRegistryTouch < 10_000) return; // Debounce: 10 seconds
      this.lastRegistryTouch = now;

      try {
        // RPC via Cloudflare's stub proxy — touch() is defined on StudioRegistry DO class
        const stub: Record<string, unknown> = this.registryStub;
        const touchFn = stub["touch"];
        if (typeof touchFn === "function") {
          void (touchFn as (t: string, id: string, v: number) => Promise<void>)(
            _actorName,
            this.actorId ?? this.ctx.id.toString(),
            this.version,
          );
        }
      } catch {
        // Fire and forget
      }
    }

    /** Fire-and-forget: update connection count in the registry. */
    updateRegistryConnections(): void {
      if (this.registryStub === null) return;

      try {
        const stub: Record<string, unknown> = this.registryStub;
        const updateFn = stub["updateConnections"];
        if (typeof updateFn === "function") {
          void (updateFn as (t: string, id: string, c: number) => Promise<void>)(
            _actorName,
            this.actorId ?? this.ctx.id.toString(),
            this.connections.size,
          );
        }
      } catch {
        // Fire and forget
      }
    }

    persistState(): void {
      const serialized = def.serialize ? def.serialize(this.state) : this.state;
      const json = JSON.stringify(serialized);
      const checksum = this.computeChecksum(json);
      const now = Date.now();

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO snapshots (id, version, state, state_tracker, actor_id, checksum, updated_at) VALUES (1, ?, ?, NULL, ?, ?, ?)",
        this.version,
        json,
        this.actorId ?? null,
        checksum,
        now,
      );

      // Timeline instrumentation — write entry if studio is enabled and a cause is pending
      if (this.studioEnabled && this.pendingCause !== null) {
        const cause = this.pendingCause;
        const { type: causeType, ...causeRest } = cause;
        const causeDataJson = JSON.stringify(causeRest);
        this.ctx.storage.sql.exec(
          "INSERT INTO timeline (cause_type, cause_data, state_snapshot, checksum, created_at) VALUES (?, ?, ?, ?, ?)",
          causeType,
          causeDataJson,
          json,
          checksum,
          now,
        );
        this.pendingCause = null;

        // Ring buffer pruning
        this.pruneTimeline();

        // Touch registry (debounced)
        this.touchRegistry();

        // Push to studio connections
        if (this.studioConnections.size > 0) {
          this.broadcastToStudio({
            type: "studio.timeline",
            entry: {
              causeType,
              causeData: causeDataJson,
              stateSnapshot: json,
              checksum,
              createdAt: now,
            },
          });
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
      // Simple hash for Phase 1 — replace with xxhash64 in Phase 2
      let h = 0;
      for (let i = 0; i < json.length; i++) {
        h = ((h << 5) - h + json.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(16);
    }

    persistExecutions(
      entries: Array<{
        id: string;
        service: string;
        input: unknown;
        status: string;
        attempts: number;
        createdAt: number;
      }>,
    ): void {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          "INSERT INTO executions (id, service, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          entry.id,
          entry.service,
          JSON.stringify(entry.input),
          entry.status,
          entry.attempts,
          entry.createdAt,
        );
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

    async drainExecutionsInner(): Promise<void> {
      const rows = this.ctx.storage.sql
        .exec("SELECT id, service, payload, attempts FROM executions WHERE status = 'pending' ORDER BY created_at")
        .toArray();

      for (const row of rows) {
        const entry = row as { id: string; service: string; payload: string; attempts: number };
        const serviceDef = def.services?.[entry.service];

        if (!serviceDef) {
          this.ctx.storage.sql.exec("UPDATE executions SET status = 'failed' WHERE id = ?", entry.id);
          continue;
        }

        const parsedInput: unknown = JSON.parse(entry.payload);

        try {
          const result = await serviceDef.fn(parsedInput, this.env);
          this.ctx.storage.sql.exec("UPDATE executions SET status = 'done' WHERE id = ?", entry.id);

          if (serviceDef.onDone) {
            const nextState = serviceDef.onDone(this.state, result, parsedInput);
            if (nextState !== this.state) {
              this.state = nextState;
              this.pendingCause = {
                type: "service.onDone",
                service: entry.service,
                input: parsedInput,
                result,
              };
              this.persistState();
              this.broadcastViews();
            }
          }
        } catch (error) {
          this.ctx.storage.sql.exec("UPDATE executions SET status = 'failed' WHERE id = ?", entry.id);

          if (serviceDef.onError) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const nextState = serviceDef.onError(this.state, { message: errorMessage }, parsedInput);
            if (nextState !== this.state) {
              this.state = nextState;
              this.pendingCause = {
                type: "service.onError",
                service: entry.service,
                input: parsedInput,
                error: errorMessage,
              };
              this.persistState();
              this.broadcastViews();
            }
          }
        }
      }
    }

    // --- Forward processing ---

    drainingForwards = false;

    persistForwards(
      entries: Array<{
        id: string;
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
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          "INSERT INTO forwards (id, link_name, target_id, message, caller, caller_type, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          entry.id,
          entry.linkName,
          entry.targetId,
          JSON.stringify(entry.message),
          caller,
          callerType,
          entry.status,
          entry.attempts,
          entry.createdAt,
        );
      }
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

    async drainForwardsInner(): Promise<void> {
      const rows = this.ctx.storage.sql
        .exec(
          "SELECT id, link_name, target_id, message, caller, caller_type FROM forwards WHERE status = 'pending' ORDER BY created_at",
        )
        .toArray();

      for (const row of rows) {
        const entry = row as {
          id: string;
          link_name: string;
          target_id: string;
          message: string;
          caller: string;
          caller_type: string;
        };

        // Resolve contract name: prefer declared link def, else lowercase the link name.
        const linkDef = def.links?.[entry.link_name];
        const contractName = linkDef ? linkDef.contract.name : entry.link_name.toLowerCase().replace(/_/g, "-");

        const stub = resolveStub(contractName, entry.target_id, this.ctx, this.env);
        if (!stub || typeof stub["send"] !== "function") {
          this.ctx.storage.sql.exec("UPDATE forwards SET status = 'failed' WHERE id = ?", entry.id);
          continue;
        }

        const parsedMessage: unknown = JSON.parse(entry.message);
        if (
          typeof parsedMessage !== "object" ||
          parsedMessage === null ||
          !("type" in parsedMessage) ||
          typeof (parsedMessage as Record<string, unknown>)["type"] !== "string"
        ) {
          this.ctx.storage.sql.exec("UPDATE forwards SET status = 'failed' WHERE id = ?", entry.id);
          continue;
        }

        const callerType: "user" | "service" = entry.caller_type === "service" ? "service" : "user";

        try {
          const sendFn = stub["send"] as (
            caller: string,
            callerType: "user" | "service",
            message: { type: string; [key: string]: unknown },
          ) => Promise<unknown>;
          await sendFn(entry.caller, callerType, parsedMessage as { type: string; [key: string]: unknown });
          this.ctx.storage.sql.exec("UPDATE forwards SET status = 'done' WHERE id = ?", entry.id);
        } catch {
          this.ctx.storage.sql.exec("UPDATE forwards SET status = 'failed' WHERE id = ?", entry.id);
        }
      }
    }

    // --- Link processing (subscriber side) ---

    /**
     * Process link intents captured during a message handler.
     * Persists to active_links, then asynchronously registers with target actors.
     */
    processLinks(
      linkCalls: Array<{ name: string; id: string }>,
      unlinkCalls: Array<{ name: string; id: string | undefined }>,
    ): void {
      // Persist link intents atomically (already inside the send() transaction)
      for (const call of linkCalls) {
        const linkDef = def.links?.[call.name];
        if (!linkDef) continue;
        const targetType = linkDef.contract.name.toUpperCase().replace(/-/g, "_");
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO active_links (target_type, target_id, link_name, version, created_at) VALUES (?, ?, ?, 0, ?)",
          targetType,
          call.id,
          call.name,
          Date.now(),
        );
      }

      // Process unlinks
      for (const call of unlinkCalls) {
        const linkDef = def.links?.[call.name];
        if (!linkDef) continue;
        const targetType = linkDef.contract.name.toUpperCase().replace(/-/g, "_");

        if (call.id !== undefined) {
          // Unlink specific target
          this.ctx.storage.sql.exec(
            "DELETE FROM active_links WHERE target_type = ? AND target_id = ? AND link_name = ?",
            targetType,
            call.id,
            call.name,
          );

          // Invoke onUnlink handler if defined
          if (linkDef.onUnlink) {
            const nextState = linkDef.onUnlink(this.state, call.id);
            if (nextState !== this.state) {
              this.state = nextState;
            }
          }
        } else {
          // Unlink all for this link name — collect IDs before deleting for onUnlink
          if (linkDef.onUnlink) {
            const idRows = this.ctx.storage.sql
              .exec("SELECT target_id FROM active_links WHERE link_name = ?", call.name)
              .toArray();
            for (const row of idRows) {
              const targetId = row["target_id"] as string;
              const nextState = linkDef.onUnlink(this.state, targetId);
              if (nextState !== this.state) {
                this.state = nextState;
              }
            }
          }

          this.ctx.storage.sql.exec("DELETE FROM active_links WHERE link_name = ?", call.name);
        }
      }

      // Async: register subscriptions with target actors (fire-and-forget)
      if (linkCalls.length > 0) {
        this.registerSubscriptions(linkCalls);
      }
      if (unlinkCalls.length > 0) {
        this.unregisterSubscriptions(unlinkCalls);
      }
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
          const stub = resolveStub(linkDef.contract.name, call.id, this.ctx, this.env);
          if (stub && typeof stub["__linkSubscribe"] === "function") {
            await (stub["__linkSubscribe"] as (subscriberType: string, subscriberId: string) => Promise<void>)(
              _actorName.toUpperCase().replace(/-/g, "_"),
              this.ctx.id.toString(),
            );
          }
        } catch (error) {
          // Target unreachable — invoke onError if defined, otherwise retry on restart
          const linkDef2 = def.links?.[call.name];
          if (linkDef2?.onError) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const nextState = linkDef2.onError(this.state, { message: errorMessage, code: "unreachable" }, call.id);
            if (nextState !== this.state) {
              this.state = nextState;
              const targetType = linkDef2.contract.name.toUpperCase().replace(/-/g, "_");
              this.pendingCause = {
                type: "link.onError",
                sourceType: targetType,
                sourceId: call.id,
                error: errorMessage,
              };
              this.persistState();
              this.broadcastViews();
            }
          }
        }
      }
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
            const stub = resolveStub(linkDef.contract.name, targetId, this.ctx, this.env);
            if (stub && typeof stub["__linkUnsubscribe"] === "function") {
              await (stub["__linkUnsubscribe"] as (subscriberType: string, subscriberId: string) => Promise<void>)(
                _actorName.toUpperCase().replace(/-/g, "_"),
                this.ctx.id.toString(),
              );
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

      if (rows.length === 0) return;

      for (const row of rows) {
        const linkRow = row as { link_name: string; version: number };

        // Monotonic version check
        if (version <= linkRow.version) continue;

        const linkDef = def.links?.[linkRow.link_name];
        if (!linkDef) continue;

        // Add role discriminant to view data
        const viewWithRole = { ...(viewData as Record<string, unknown>), role };

        // Run onUpdate reducer
        const nextState = linkDef.onUpdate(this.state, viewWithRole, sourceId);
        if (nextState !== this.state) {
          this.state = nextState;

          // Update version
          this.ctx.storage.sql.exec(
            "UPDATE active_links SET version = ? WHERE target_type = ? AND target_id = ? AND link_name = ?",
            version,
            sourceType,
            sourceId,
            linkRow.link_name,
          );

          this.pendingCause = {
            type: "link.onUpdate",
            sourceType,
            sourceId,
            viewData: viewWithRole,
          };
          this.persistState();
          this.broadcastViews();
        }
      }
    }

    // --- Source-side push to DO subscribers ---

    /**
     * Push view updates to all DO subscribers.
     * Called after broadcastViews() to keep DO subscribers in sync.
     */
    pushToSubscribers(): void {
      const rows = this.ctx.storage.sql.exec("SELECT subscriber_type, subscriber_id FROM link_subscribers").toArray();

      for (const row of rows) {
        const subscriberType = row["subscriber_type"] as string;
        const subscriberId = row["subscriber_id"] as string;
        this.pushToSubscriber(subscriberType, subscriberId);
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
        const stub = resolveStub(subscriberType.toLowerCase().replace(/_/g, "-"), subscriberId, this.ctx, this.env);
        if (stub && typeof stub["__receiveLinkUpdate"] === "function") {
          // Fire and forget
          void (
            stub["__receiveLinkUpdate"] as (
              sourceType: string,
              sourceId: string,
              viewData: unknown,
              role: string,
              version: number,
            ) => Promise<void>
          )(sourceType, sourceId, viewData, role, version);
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

      const calls: Array<{ name: string; id: string }> = [];
      for (const row of rows) {
        calls.push({
          name: row["link_name"] as string,
          id: row["target_id"] as string,
        });
      }

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
      if (this.initialized) return; // Idempotent

      // Validate input
      const parsed = def.input.safeParse(input.input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }

      // Store actor ID for JWT validation
      this.actorId = input.actorId ?? this.ctx.id.toString();

      // Create initial state with link support
      const initLinks: Array<{ name: string; id: string }> = [];
      const initCtx = {
        env: this.env,
        link: async (name: string, id: string): Promise<unknown> => {
          const linkDef = def.links?.[name];
          if (!linkDef) throw new Error(`Link "${name}" not declared in actor definition`);

          const stub = resolveStub(linkDef.contract.name, id, this.ctx, this.env);
          if (!stub || typeof stub["getSnapshot"] !== "function") {
            throw new Error(`Link "${name}": target actor unreachable`);
          }

          const result = await (
            stub["getSnapshot"] as (caller: string, callerType: string) => Promise<{ snapshot: unknown; role: string }>
          )("system", "service");

          // Record the link for persistence
          initLinks.push({ name, id });

          // Return view with role discriminant
          return { role: result.role, ...(result.snapshot as Record<string, unknown>) };
        },
      };

      this.state = await def.init(parsed.data, initCtx);
      this.initialized = true;

      // Persist state + init links atomically
      this.pendingCause = { type: "init" };
      this.ctx.storage.transactionSync(() => {
        this.persistState();
        for (const { name, id } of initLinks) {
          const linkDef = def.links?.[name];
          if (linkDef) {
            const targetType = linkDef.contract.name.toUpperCase().replace(/-/g, "_");
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO active_links (target_type, target_id, link_name, version, created_at) VALUES (?, ?, ?, 0, ?)",
              targetType,
              id,
              name,
              Date.now(),
            );
          }
        }
      });

      // Register subscriptions for init links (fire-and-forget)
      if (initLinks.length > 0) {
        this.registerSubscriptions(initLinks);
      }
    }

    async send(
      caller: string,
      callerType: "user" | "service",
      event: { type: string; [key: string]: unknown },
    ): Promise<{ ok: boolean; error?: string; detail?: string }> {
      await this.loadState();
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
      const messages = def.messages;

      // Create outbox collector
      const outbox = createOutbox();

      const ctx: Omit<MessageContext, "role"> = {
        caller,
        callerType,
        env: this.env,
        execute: (service: string, input: unknown) => outbox.execute(service, input),
        link: (name: string, id: string) => outbox.link(name, id),
        unlink: (name: string, id?: string) => outbox.unlink(name, id),
        forward: (linkName, targetId, message) => outbox.forward(linkName, targetId, message),
      };

      // Route message
      const result = routeMessage(messages, role, this.state, event, ctx);

      if (!result.ok) {
        const base: { ok: false; error: string; detail?: string } = { ok: false, error: result.error };
        if (result.detail !== undefined) {
          base.detail = result.detail;
        }
        return base;
      }

      // Observability hook
      const prevState = this.state;

      // Update state
      this.state = result.state;

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

      // Fire onTransition if defined
      if (def.observe?.onTransition) {
        try {
          def.observe.onTransition(prevState, this.state, event, { caller, role });
        } catch {
          // Observability hooks must not break the transition
        }
      }

      // Persist state + executions + link intents atomically
      const executionEntries = outbox.toExecutionEntries();
      const linkCalls = outbox.getLinks();
      const unlinkCalls = outbox.getUnlinks();
      const forwardEntries = outbox.toForwardEntries();
      this.ctx.storage.transactionSync(() => {
        this.persistState();
        if (executionEntries.length > 0) {
          this.persistExecutions(executionEntries);
        }
        if (linkCalls.length > 0 || unlinkCalls.length > 0) {
          this.processLinks(linkCalls, unlinkCalls);
        }
        if (forwardEntries.length > 0) {
          this.persistForwards(forwardEntries, caller, callerType);
        }
      });

      // Broadcast views to connected clients and DO subscribers
      this.broadcastViews();

      // Drain executions asynchronously
      if (executionEntries.length > 0) {
        this.drainExecutions();
      }

      // Drain forwards asynchronously
      if (forwardEntries.length > 0) {
        this.drainForwards();
      }

      return { ok: true };
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
      const tags = this.ctx.getTags(ws);
      const callerTag = tags.find((t: string) => t.startsWith("caller:"));
      if (callerTag?.slice("caller:".length) === "__studio") {
        this.studioConnections.add(ws); // Re-populate after hibernation
        return true;
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
      const allSockets = this.ctx.getWebSockets();
      const roleNames = Object.keys(def.roles);

      for (const ws of allSockets) {
        // Skip studio connections — they don't receive view projections
        if (this.isStudioWs(ws)) continue;

        const info = this.getCallerFromWs(ws);
        if (!info) continue;
        const { caller, callerType: ct } = info;
        try {
          const role = resolveRole(def.roles, this.state, caller, { callerType: ct });
          if (role === null) continue;

          const viewDef = def.views[role];
          if (viewDef === undefined) continue;

          const viewData = viewDef.fn(this.state, caller);
          // Include role in dedupe key — role change with identical data still triggers update
          const dedupeKey = `${role}:${JSON.stringify(viewData)}`;

          const prevKey = this.previousViews.get(ws);
          if (dedupeKey === prevKey) continue;

          // Detect role change: if the role portion of the previous dedupe key differs,
          // the client has an old schema's snapshot — delta would corrupt the view.
          const prevRole = prevKey?.split(":")[0];
          const roleChanged = prevRole !== undefined && prevRole !== role;

          const prevViewData = roleChanged ? undefined : this.previousViewData.get(ws);
          if (roleChanged) {
            // Clear stale view data so next broadcast starts fresh
            this.previousViewData.delete(ws);
          }
          this.previousViews.set(ws, dedupeKey);
          this.previousViewData.set(ws, viewData as Record<string, unknown>);
          this.connectionChecksums.set(ws, this.computeChecksum(JSON.stringify(viewData)));

          // Use binary encoding when the view has a schema AND connection supports binary
          const viewSchema = viewDef.schema;
          const connSupportsBinary = this.supportsBinary.get(ws) ?? false;
          if (viewSchema?.fields && connSupportsBinary) {
            const schemaDef = viewSchema as SchemaDefinition<Record<string, FieldDescriptor>>;

            // Try delta encoding if we have previous view data (skip if role changed)
            if (prevViewData) {
              const deltaPayload = encodeDelta(schemaDef, prevViewData, viewData as Record<string, unknown>);
              if (deltaPayload) {
                const frame = createDeltaFrame(this.version, deltaPayload);
                ws.send(frame);
                continue; // Delta sent successfully
              }
            }

            // Full snapshot (first connect, role changed, or delta returned null)
            const payload = encode(schemaDef, viewData as Record<string, unknown>);
            const roleIndex = roleNames.indexOf(role);
            const frame = createSnapshotFrame(this.version, roleIndex, payload);
            ws.send(frame);
          } else {
            // JSON fallback (no schema or connection doesn't support binary)
            ws.send(JSON.stringify({ type: "snapshot", role, data: viewData }));
          }
        } catch {
          // Connection may have closed
        }
      }

      // Push to DO subscribers (source-side)
      this.pushToSubscribers();
    }

    async fetch(request: Request): Promise<Response> {
      // WebSocket upgrade
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      // --- Caller identity resolution (Worker-trust model) ---
      // The Worker authenticates the caller and stamps identity via withCallerIdentity().
      // SECURITY: withCallerIdentity scrubs inbound headers before setting verified ones.
      // Workers MUST call withCallerIdentity() before forwarding to the DO — forwarding
      // raw client requests (stub.fetch(request)) allows header spoofing.
      // CORS/Origin validation is handled at the Worker level (e.g., Hono cors() middleware).
      const headerCallerId = request.headers.get(CALLER_ID_HEADER);
      const headerCallerType = request.headers.get(CALLER_TYPE_HEADER);

      if (!headerCallerId || !headerCallerType) {
        return new Response("Missing caller identity", { status: 401 });
      }
      if (headerCallerType !== "user" && headerCallerType !== "service") {
        return new Response("Invalid caller type", { status: 401 });
      }
      // TypeScript can't narrow string → "user"|"service" via !== guards alone; use positively-matched union.
      const callerType: "user" | "service" = headerCallerType === "user" ? "user" : "service";
      const callerInfo = { caller: headerCallerId, callerType };

      await this.loadState();
      if (!this.initialized) {
        return new Response("Actor requires input — call spawn({ input }) before connecting", { status: 404 });
      }

      // Studio WebSocket — bypass role evaluation entirely
      if (headerCallerId === "__studio") {
        return this.handleStudioWebSocket(request);
      }

      const role = resolveRole(def.roles, this.state, callerInfo.caller, { callerType: callerInfo.callerType });
      if (role === null) {
        return new Response("Forbidden", { status: 403 });
      }

      const clientSupportsBinary = request.headers.get(BINARY_SUPPORT_HEADER) === "1";

      // Read requested WebSocket subprotocols so we can echo one back.
      // The browser rejects the upgrade unless the server acknowledges one of
      // the protocols the client requested. The Actor Kit client SDK always
      // includes "actor-kit.v1" alongside optional "auth.<token>".
      const reqProtocolHeader = request.headers.get("Sec-WebSocket-Protocol");
      const requestedProtocols = reqProtocolHeader?.split(",").map((p) => p.trim()) ?? [];
      const responseProtocol = requestedProtocols.includes("actor-kit.v1") ? "actor-kit.v1" : null;

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Store caller metadata as WebSocket tags so they survive DO hibernation.
      // Tags: ["caller:{id}", "callerType:{type}"]
      const tags = [`caller:${callerInfo.caller}`, `callerType:${callerInfo.callerType}`];
      if (clientSupportsBinary) tags.push("binary");
      this.ctx.acceptWebSocket(server, tags);
      this.connections.set(server, { caller: callerInfo.caller, callerType: callerInfo.callerType });

      // Notify studio of new connection
      if (this.studioConnections.size > 0) {
        this.broadcastToStudio({
          type: "studio.connection",
          action: "connect",
          connection: { caller: callerInfo.caller, callerType: callerInfo.callerType },
        });
      }

      // Update registry connection count
      this.updateRegistryConnections();
      this.supportsBinary.set(server, clientSupportsBinary);

      // Send initial snapshot — binary if schema available, JSON fallback
      const viewDef = def.views[role];
      if (viewDef) {
        const viewData = viewDef.fn(this.state, callerInfo.caller);
        const json = JSON.stringify(viewData);
        const dedupeKey = `${role}:${json}`;
        const checksum = this.computeChecksum(json);
        this.previousViews.set(server, dedupeKey);
        this.previousViewData.set(server, viewData as Record<string, unknown>);
        this.connectionChecksums.set(server, checksum);

        const viewSchema = viewDef.schema;
        if (viewSchema?.fields && clientSupportsBinary) {
          const schemaDef = viewSchema as SchemaDefinition<Record<string, FieldDescriptor>>;
          const payload = encode(schemaDef, viewData as Record<string, unknown>);
          const roleNames = Object.keys(def.roles);
          const roleIndex = roleNames.indexOf(role);
          const frame = createSnapshotFrame(this.version, roleIndex, payload);
          server.send(frame);
        } else {
          server.send(JSON.stringify({ type: "snapshot", role, data: viewData }));
        }
      }

      // Run lifecycle.connect if defined
      if (def.lifecycle?.connect) {
        const connectOutbox = createOutbox();
        const connectCtx = {
          caller: callerInfo.caller,
          callerType: callerInfo.callerType,
          env: this.env,
          execute: (service: string, input: unknown) => connectOutbox.execute(service, input),
          forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) =>
            connectOutbox.forward(linkName, targetId, message),
        };
        const nextState = def.lifecycle.connect(
          this.state,
          { caller: callerInfo.caller, callerType: callerInfo.callerType },
          connectCtx,
        );
        if (nextState instanceof Promise) {
          throw new Error("lifecycle.connect returned a Promise. Handlers must be synchronous.");
        }
        const connectExecutions = connectOutbox.toExecutionEntries();
        const connectForwards = connectOutbox.toForwardEntries();
        if (nextState !== this.state || connectExecutions.length > 0 || connectForwards.length > 0) {
          this.state = nextState;
          this.pendingCause = {
            type: "lifecycle.connect",
            caller: callerInfo.caller,
            callerType: callerInfo.callerType,
            role,
          };
          this.ctx.storage.transactionSync(() => {
            this.persistState();
            if (connectExecutions.length > 0) {
              this.persistExecutions(connectExecutions);
            }
            if (connectForwards.length > 0) {
              this.persistForwards(connectForwards, callerInfo.caller, callerInfo.callerType);
            }
          });
          this.broadcastViews();
          if (connectExecutions.length > 0) {
            this.drainExecutions();
          }
          if (connectForwards.length > 0) {
            this.drainForwards();
          }
        }
      }

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

    async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
      if (typeof data !== "string") return;

      // Studio connections: handle view requests, not app messages
      if (this.isStudioWs(ws)) {
        this.handleStudioMessage(ws, data);
        return;
      }

      const info = this.getCallerFromWs(ws);
      if (!info) return;
      const { caller, callerType } = info;

      try {
        const parsed: unknown = JSON.parse(data);
        // Parse at the boundary: validate the message has at minimum a type field
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("type" in parsed) ||
          typeof (parsed as Record<string, unknown>)["type"] !== "string"
        ) {
          ws.send(JSON.stringify({ type: "__error", detail: "Message must have a string 'type' field" }));
          return;
        }
        const event = parsed as Record<string, unknown> & { type: string };

        // Handle reconnect handshake
        if (event.type === "__reconnect" && typeof event["lastChecksum"] === "string") {
          await this.handleReconnect(ws, caller, callerType, event["lastChecksum"]);
          return;
        }

        const result = await this.send(caller, callerType, event);
        // Send error frame back to client if message was rejected
        if (!result.ok) {
          const errorPayload: Record<string, unknown> = { type: "__error", message: event.type, error: result.error };
          if (result.detail !== undefined) {
            errorPayload["detail"] = result.detail;
          }
          ws.send(JSON.stringify(errorPayload));
        }
      } catch {
        ws.send(JSON.stringify({ type: "__error", detail: "Invalid message" }));
      }
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
      const json = JSON.stringify(viewData);
      const currentChecksum = this.computeChecksum(json);

      if (currentChecksum === lastChecksum) {
        // State hasn't changed — send ack, no data needed
        ws.send(JSON.stringify({ type: "__reconnect_ack", checksum: currentChecksum }));
      } else {
        // State changed — send full snapshot (we don't have the client's previous view)
        this.previousViewData.set(ws, viewData as Record<string, unknown>);
        this.connectionChecksums.set(ws, currentChecksum);

        const viewSchema = viewDef.schema;
        const connSupportsBinary = this.supportsBinary.get(ws) ?? false;
        if (viewSchema?.fields && connSupportsBinary) {
          const schemaDef = viewSchema as SchemaDefinition<Record<string, FieldDescriptor>>;
          const payload = encode(schemaDef, viewData as Record<string, unknown>);
          const roleNames = Object.keys(def.roles);
          const roleIndex = roleNames.indexOf(role);
          ws.send(createSnapshotFrame(this.version, roleIndex, payload));
        } else {
          ws.send(JSON.stringify({ type: "snapshot", role, data: viewData }));
        }
      }
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
      // Studio connections — just clean up, no lifecycle
      if (this.isStudioWs(ws)) {
        this.studioConnections.delete(ws);
        return;
      }

      const info = this.getCallerFromWs(ws);
      if (!info) return;
      const { caller } = info;

      this.connections.delete(ws);
      this.previousViews.delete(ws);
      this.previousViewData.delete(ws);
      this.connectionChecksums.delete(ws);
      this.supportsBinary.delete(ws);

      // Notify studio of disconnection
      if (this.studioConnections.size > 0) {
        this.broadcastToStudio({
          type: "studio.connection",
          action: "disconnect",
          connection: { caller, callerType: info.callerType },
        });
      }

      // Update registry connection count
      this.updateRegistryConnections();

      // Run lifecycle.disconnect if defined
      if (def.lifecycle?.disconnect) {
        const disconnectOutbox = createOutbox();
        const disconnectCtx = {
          caller,
          callerType: info.callerType,
          env: this.env,
          execute: (service: string, input: unknown) => disconnectOutbox.execute(service, input),
          forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) =>
            disconnectOutbox.forward(linkName, targetId, message),
        };
        const nextState = def.lifecycle.disconnect(this.state, { caller, callerType: info.callerType }, disconnectCtx);
        if (nextState instanceof Promise) {
          throw new Error("lifecycle.disconnect returned a Promise. Handlers must be synchronous.");
        }
        const disconnectExecutions = disconnectOutbox.toExecutionEntries();
        const disconnectForwards = disconnectOutbox.toForwardEntries();
        if (nextState !== this.state || disconnectExecutions.length > 0 || disconnectForwards.length > 0) {
          this.state = nextState;
          const disconnectRole = resolveRole(def.roles, this.state, caller, { callerType: info.callerType });
          this.pendingCause = {
            type: "lifecycle.disconnect",
            caller,
            callerType: info.callerType,
            role: disconnectRole ?? "unknown",
          };
          this.ctx.storage.transactionSync(() => {
            this.persistState();
            if (disconnectExecutions.length > 0) {
              this.persistExecutions(disconnectExecutions);
            }
            if (disconnectForwards.length > 0) {
              this.persistForwards(disconnectForwards, caller, info.callerType);
            }
          });
          this.broadcastViews();
          if (disconnectForwards.length > 0) {
            this.drainForwards();
          }
          if (disconnectExecutions.length > 0) {
            this.drainExecutions();
          }
        }
      }
    }

    // --- Studio WebSocket handling ---

    /** Handle a studio WebSocket connection — bypasses roles, sends full state + timeline. */
    handleStudioWebSocket(request: Request): Response {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      const tags = ["caller:__studio", "callerType:service"];
      this.ctx.acceptWebSocket(server, tags);
      this.studioConnections.add(server);

      // Send initial snapshot
      const snapshot = this.buildStudioSnapshot();
      server.send(JSON.stringify(snapshot));

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

    /** Build the initial studio snapshot payload. */
    buildStudioSnapshot(): Record<string, unknown> {
      // Connections
      const connections: Array<{ caller: string; callerType: "user" | "service" }> = [];
      for (const [, info] of this.connections) {
        connections.push({ caller: info.caller, callerType: info.callerType });
      }

      // Timeline entries
      const timelineRows = this.ctx.storage.sql
        .exec(
          "SELECT id, cause_type, cause_data, state_snapshot, checksum, created_at FROM timeline ORDER BY id DESC LIMIT 50",
        )
        .toArray();
      const timeline = timelineRows.map((row) => ({
        id: row["id"] as number,
        causeType: row["cause_type"] as string,
        causeData: row["cause_data"] as string,
        stateSnapshot: row["state_snapshot"] as string,
        checksum: row["checksum"] as string,
        createdAt: row["created_at"] as number,
      }));

      // Outbox
      const execRows = this.ctx.storage.sql
        .exec("SELECT id, service, payload, status, attempts, created_at FROM executions ORDER BY id DESC")
        .toArray();
      const outbox = execRows.map((row) => ({
        id: row["id"] as string,
        service: row["service"] as string,
        payload: row["payload"] as string,
        status: row["status"] as string,
        attempts: row["attempts"] as number,
        createdAt: row["created_at"] as number,
      }));

      // Links
      const linkRows = this.ctx.storage.sql
        .exec("SELECT target_type, target_id, link_name, version FROM active_links")
        .toArray();
      const activeLinks = linkRows.map((row) => ({
        targetType: row["target_type"] as string,
        targetId: row["target_id"] as string,
        linkName: row["link_name"] as string,
        version: row["version"] as number,
      }));

      const subRows = this.ctx.storage.sql
        .exec("SELECT subscriber_type, subscriber_id FROM link_subscribers")
        .toArray();
      const linkSubscribers = subRows.map((row) => ({
        subscriberType: row["subscriber_type"] as string,
        subscriberId: row["subscriber_id"] as string,
      }));

      return {
        type: "studio.snapshot",
        state: this.state,
        timeline,
        connections,
        outbox,
        activeLinks,
        linkSubscribers,
        actorType: _actorName,
        actorId: this.actorId ?? this.ctx.id.toString(),
        version: this.version,
      };
    }

    /** Handle a message from a studio WebSocket (e.g., view requests). */
    handleStudioMessage(ws: WebSocket, data: string): void {
      try {
        const parsed: unknown = JSON.parse(data);
        if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return;
        const msg = parsed as Record<string, unknown> & { type: string };

        if (msg.type === "studio.requestView") {
          const role = msg["role"] as string | undefined;
          const caller = (msg["caller"] as string | undefined) ?? "__studio";
          if (role === undefined) return;

          const viewDef = def.views[role];
          if (viewDef === undefined) {
            ws.send(JSON.stringify({ type: "studio.view", role, error: "No view for role" }));
            return;
          }

          const viewData = viewDef.fn(this.state, caller);
          ws.send(
            JSON.stringify({
              type: "studio.view",
              role,
              caller: msg["caller"] ?? null,
              data: viewData,
            }),
          );
        }
      } catch {
        // Invalid message — ignore
      }
    }

    /** Send a message to all connected studio WebSockets. */
    broadcastToStudio(message: Record<string, unknown>): void {
      const json = JSON.stringify(message);
      for (const ws of this.studioConnections) {
        try {
          ws.send(json);
        } catch {
          this.studioConnections.delete(ws);
        }
      }
    }

    // --- Studio RPC methods ---

    /** Studio RPC: returns current state + metadata for inspection. */
    async __inspect(): Promise<{
      state: unknown;
      version: number;
      actorId: string | null;
      connections: Array<{ caller: string; callerType: "user" | "service" }>;
      outbox: Array<{
        id: string;
        service: string;
        payload: string;
        status: string;
        attempts: number;
        createdAt: number;
      }>;
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
      await this.loadState();

      // Current connections
      const connList: Array<{ caller: string; callerType: "user" | "service" }> = [];
      for (const [, info] of this.connections) {
        connList.push({ caller: info.caller, callerType: info.callerType });
      }

      // Outbox / executions
      const execRows = this.ctx.storage.sql
        .exec("SELECT id, service, payload, status, attempts, created_at FROM executions ORDER BY id DESC")
        .toArray();
      const outbox = execRows.map((row) => ({
        id: row["id"] as string,
        service: row["service"] as string,
        payload: row["payload"] as string,
        status: row["status"] as string,
        attempts: row["attempts"] as number,
        createdAt: row["created_at"] as number,
      }));

      // Active links
      const linkRows = this.ctx.storage.sql
        .exec("SELECT target_type, target_id, link_name, version FROM active_links")
        .toArray();
      const activeLinks = linkRows.map((row) => ({
        targetType: row["target_type"] as string,
        targetId: row["target_id"] as string,
        linkName: row["link_name"] as string,
        version: row["version"] as number,
      }));

      // Subscribers
      const subRows = this.ctx.storage.sql
        .exec("SELECT subscriber_type, subscriber_id FROM link_subscribers")
        .toArray();
      const linkSubscribers = subRows.map((row) => ({
        subscriberType: row["subscriber_type"] as string,
        subscriberId: row["subscriber_id"] as string,
      }));

      return {
        state: this.state,
        version: this.version,
        actorId: this.actorId ?? null,
        connections: connList,
        outbox,
        activeLinks,
        linkSubscribers,
      };
    }

    /** Studio RPC: returns paginated timeline entries. */
    async __getTimeline(opts?: { limit?: number; before?: number }): Promise<{
      entries: Array<{
        id: number;
        causeType: string;
        causeData: string;
        stateSnapshot: string;
        checksum: string;
        createdAt: number;
      }>;
      hasMore: boolean;
    }> {
      await this.loadState();

      const limit = opts?.limit ?? 50;
      const before = opts?.before;

      let rows: Record<string, SqlStorageValue>[];
      if (before !== undefined) {
        rows = this.ctx.storage.sql
          .exec(
            "SELECT id, cause_type, cause_data, state_snapshot, checksum, created_at FROM timeline WHERE id < ? ORDER BY id DESC LIMIT ?",
            before,
            limit + 1,
          )
          .toArray();
      } else {
        rows = this.ctx.storage.sql
          .exec(
            "SELECT id, cause_type, cause_data, state_snapshot, checksum, created_at FROM timeline ORDER BY id DESC LIMIT ?",
            limit + 1,
          )
          .toArray();
      }

      const hasMore = rows.length > limit;
      const entries = rows.slice(0, limit).map((row) => ({
        id: row["id"] as number,
        causeType: row["cause_type"] as string,
        causeData: row["cause_data"] as string,
        stateSnapshot: row["state_snapshot"] as string,
        checksum: row["checksum"] as string,
        createdAt: row["created_at"] as number,
      }));

      return { entries, hasMore };
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
  if (typeof def !== "object" || def === null) return false;
  if (!("input" in def) || typeof def.input !== "object" || def.input === null) return false;
  if (!("init" in def) || typeof def.init !== "function") return false;
  if (!("roles" in def) || typeof def.roles !== "object" || def.roles === null) return false;
  if (!("views" in def) || typeof def.views !== "object" || def.views === null) return false;
  // Optional links: if present, must be an object with link definitions
  if ("links" in def && def.links !== undefined) {
    if (typeof def.links !== "object" || def.links === null) return false;
    const linksObj = def.links as Record<string, unknown>;
    for (const val of Object.values(linksObj)) {
      if (typeof val !== "object" || val === null) return false;
      if (!("contract" in val) || !("onUpdate" in val)) return false;
    }
  }
  return true;
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
type ContractEvents<T> = T extends {
  def: { messages: Record<string, { schema: { _output: unknown } }> };
}
  ? {
      [K in keyof T["def"]["messages"] & string]: T["def"]["messages"][K] extends {
        schema: { _output: infer P };
      }
        ? { type: K } & P
        : { type: K };
    }[keyof T["def"]["messages"] & string]
  : { type: string; [key: string]: unknown };

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
      event: ContractEvents<TContract>,
    ): Promise<{ ok: boolean; error?: string }>;
    getSnapshot(
      caller: string,
      callerType: "user" | "service",
    ): Promise<{ checksum: string; snapshot: unknown; role: string }>;
    fetch(request: Request): Promise<Response>;
    __inspect(): Promise<{
      state: unknown;
      version: number;
      actorId: string | null;
      connections: Array<{ caller: string; callerType: "user" | "service" }>;
      outbox: Array<{
        id: string;
        service: string;
        payload: string;
        status: string;
        attempts: number;
        createdAt: number;
      }>;
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
    __getTimeline(opts?: { limit?: number; before?: number }): Promise<{
      entries: Array<{
        id: number;
        causeType: string;
        causeData: string;
        stateSnapshot: string;
        checksum: string;
        createdAt: number;
      }>;
      hasMore: boolean;
    }>;
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
