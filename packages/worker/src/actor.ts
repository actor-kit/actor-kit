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
import type { Effect, FieldDescriptor, MessageContext, SchemaDefinition } from "@actor-kit/core";
import { createDeltaFrame, createSnapshotFrame, encode, encodeDelta } from "@actor-kit/core";
import type { z } from "zod";
import { getCallerFromToken } from "./auth";
import { BINARY_SUPPORT_HEADER, CALLER_ID_HEADER, CALLER_TYPE_HEADER } from "./identity";
import { routeMessage } from "./runtime/message-router";
import { createOutbox, type OutboxEntry } from "./runtime/outbox";
import { resolveRole } from "./runtime/roles";
import { resolveMessagesForState } from "./runtime/states";
import { parseDuration } from "./runtime/timers";

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
  init(input: unknown, env: unknown): unknown | Promise<unknown>; // bivariant — optionally async, receives env
  version?: number;
  initial?: string;
  roles: Record<
    string,
    {
      // bivariant method signature for role predicates
      (state: unknown, caller: string, claims: { callerType: "user" | "service" }): boolean;
    }
  >;
  messages?: Record<string, Record<string, ActorMessageSlot>>;
  states?:
    | Record<
        string,
        {
          messages: Record<string, Record<string, ActorMessageSlot>>;
        }
      >
    | {
        parallel: true;
        regions: Record<
          string,
          {
            initial: string;
            states: Record<
              string,
              {
                messages: Record<string, Record<string, ActorMessageSlot>>;
              }
            >;
          }
        >;
      };
  views: Record<
    string,
    {
      fn(state: unknown, caller: string): unknown; // bivariant
      schema?: { fields: readonly { name: string; type: string }[] }; // optional schema for binary encoding
    }
  >;
  lifecycle?: {
    connect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
    disconnect?(state: unknown, event: { caller: string; callerType: "user" | "service" }, ctx: unknown): unknown;
  };
  after?: Record<string, (state: unknown) => unknown>;
  tick?: {
    frequency: number;
    handler(state: unknown): unknown;
  };
  observe?: {
    onTransition?(
      prevState: unknown,
      nextState: unknown,
      event: { type: string },
      ctx: { caller: string; role: string },
    ): void;
  };
  migrate?(persisted: unknown, fromVersion: number): unknown;
  serialize?(state: unknown): unknown;
  restore?(serialized: unknown): unknown;
}

// --- SQL table creation ---

const CREATE_TABLES_SQL = `
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
  CREATE TABLE IF NOT EXISTS emission_failures (
    id TEXT PRIMARY KEY,
    type TEXT,
    payload TEXT,
    error TEXT,
    failed_at INTEGER
  );
`;

// --- actor() function ---

export function actor(
  actorName: string,
  def: ActorDef,
): { new (ctx: DurableObjectState, env: Record<string, unknown>): DurableObject } {
  return class ActorInstance extends DurableObject {
    state: unknown = undefined;
    actorId: string | undefined = undefined; // Human-readable ID (the name passed to idFromName)
    stateTracker: Record<string, string> | { current: string } | undefined = undefined;
    initialized = false;
    version: number;
    // Keyed by WebSocket (not caller) to support multi-tab/multi-device
    connections = new Map<WebSocket, { caller: string; callerType: "user" | "service" }>();
    previousViews = new Map<WebSocket, string>(); // dedupe key: "role:json"
    previousViewData = new Map<WebSocket, Record<string, unknown>>(); // actual view data for delta computation
    connectionChecksums = new Map<WebSocket, string>(); // last checksum sent per connection
    supportsBinary = new Map<WebSocket, boolean>(); // per-connection binary capability
    draining = false; // Prevents concurrent outbox drains

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.version = def.version ?? 1;
      // Load state before any requests are served.
      // blockConcurrencyWhile ensures no fetch/send/WebSocket during init.
      this.ctx.blockConcurrencyWhile(async () => {
        await this.loadState();
      });
    }

    async ensureTables(): Promise<void> {
      this.ctx.storage.sql.exec(CREATE_TABLES_SQL);
    }

    async loadState(): Promise<void> {
      if (this.initialized) return;

      await this.ensureTables();

      const rows = this.ctx.storage.sql
        .exec("SELECT state, version, state_tracker, actor_id FROM snapshots WHERE id = 1")
        .toArray();

      if (rows.length > 0 && rows[0] !== undefined) {
        const row = rows[0] as {
          state: string;
          version: number;
          state_tracker: string | null;
          actor_id: string | null;
        };
        let parsed: unknown = JSON.parse(row.state);

        // Run migration if needed
        if (def.migrate && row.version !== this.version) {
          parsed = def.migrate(parsed, row.version);
        }

        // Restore state
        this.state = def.restore ? def.restore(parsed) : parsed;

        // Restore state tracker
        if (row.state_tracker !== null) {
          this.stateTracker = JSON.parse(row.state_tracker);
        }

        // Restore actor ID
        if (row.actor_id !== null) {
          this.actorId = row.actor_id;
        }

        this.initialized = true;

        // Drain any pending outbox entries from before crash/restart
        this.drainOutbox();
      } else {
        // No persisted state — try auto-spawn with empty input
        const emptyParsed = def.input.safeParse({});
        if (emptyParsed.success) {
          this.actorId = this.ctx.id.toString();
          this.state = await def.init(emptyParsed.data, this.env);
          this.initialized = true;

          // Initialize state tracker if using states
          if (def.states) {
            const statesDef = def.states;
            if ("parallel" in statesDef && statesDef.parallel === true) {
              const tracker: Record<string, string> = {};
              for (const [regionName, regionDef] of Object.entries(statesDef.regions)) {
                tracker[regionName] = regionDef.initial;
              }
              this.stateTracker = tracker;
            } else if (def.initial) {
              this.stateTracker = { current: def.initial };
            } else {
              const firstState = Object.keys(statesDef)[0];
              if (firstState !== undefined) {
                this.stateTracker = { current: firstState };
              }
            }
          }

          this.persistState();
          this.scheduleAfterTimers();
        }
        // If input requires fields, stay uninitialized — spawn() must be called explicitly
      }
    }

    persistState(): void {
      const serialized = def.serialize ? def.serialize(this.state) : this.state;
      const json = JSON.stringify(serialized);
      const checksum = this.computeChecksum(json);
      const stateTrackerJson = this.stateTracker ? JSON.stringify(this.stateTracker) : null;

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO snapshots (id, version, state, state_tracker, actor_id, checksum, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
        this.version,
        json,
        stateTrackerJson,
        this.actorId ?? null,
        checksum,
        Date.now(),
      );
    }

    persistOutbox(entries: OutboxEntry[]): void {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          "INSERT INTO outbox (id, type, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          entry.id,
          "emit",
          JSON.stringify(entry.payload),
          entry.status,
          entry.attempts,
          entry.createdAt,
        );
      }
    }

    computeChecksum(json: string): string {
      // Simple hash for Phase 1 — replace with xxhash64 in Phase 2
      let h = 0;
      for (let i = 0; i < json.length; i++) {
        h = ((h << 5) - h + json.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(16);
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

      // Create initial state
      this.state = await def.init(parsed.data, this.env);
      this.initialized = true;

      // Initialize state tracker if using states
      if (def.states) {
        const statesDef = def.states;
        if ("parallel" in statesDef && statesDef.parallel === true) {
          // Parallel: track each region's initial state
          const tracker: Record<string, string> = {};
          for (const [regionName, regionDef] of Object.entries(statesDef.regions)) {
            tracker[regionName] = regionDef.initial;
          }
          this.stateTracker = tracker;
        } else if (def.initial) {
          // Sequential: use the explicit initial state
          this.stateTracker = { current: def.initial };
        } else {
          // Sequential without explicit initial: use first state key
          const firstState = Object.keys(statesDef)[0];
          if (firstState !== undefined) {
            this.stateTracker = { current: firstState };
          }
        }
      }

      // Persist
      this.persistState();

      // Schedule after timers
      this.scheduleAfterTimers();
    }

    async send(
      caller: string,
      callerType: "user" | "service",
      event: { type: string; [key: string]: unknown },
    ): Promise<{ ok: boolean; error?: string }> {
      await this.loadState();
      if (!this.initialized) {
        return { ok: false, error: "Actor not initialized" };
      }

      // Resolve role
      const role = resolveRole(def.roles, this.state, caller, { callerType });
      if (role === null) {
        return { ok: false, error: "No role matched" };
      }

      // Resolve messages for current state
      const messages = resolveMessagesForState(def.messages, def.states, this.stateTracker);
      if (messages === undefined) {
        return { ok: false, error: "No messages available" };
      }

      // Create outbox collector
      const outbox = createOutbox();

      const ctx: Omit<MessageContext, "role"> = {
        caller,
        callerType,
        env: this.env,
        emit: (effect: Effect) => outbox.emit(effect),
      };

      // Route message
      const result = routeMessage(messages, role, this.state, event, ctx);

      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      // Observability hook
      const prevState = this.state;

      // Update state
      this.state = result.state;

      // Check if handler triggered a state transition via the state field
      // Convention: if the state has a `__actorState` field, use it to advance the tracker
      if (this.stateTracker && typeof this.state === "object" && this.state !== null) {
        const stateObj = this.state as Record<string, unknown>;
        if (typeof stateObj["__actorState"] === "string") {
          const newStateName = stateObj["__actorState"];
          if ("current" in this.stateTracker) {
            this.stateTracker = { current: newStateName };
          }
        }
      }

      // Fire onTransition if defined
      if (def.observe?.onTransition) {
        try {
          def.observe.onTransition(prevState, this.state, event, { caller, role });
        } catch {
          // Observability hooks must not break the transition
        }
      }

      // Persist state + outbox atomically
      this.ctx.storage.transactionSync(() => {
        this.persistState();
        this.persistOutbox(outbox.toEntries());
      });

      // Broadcast views to connected clients
      this.broadcastViews();

      // Drain outbox asynchronously (don't await — fire and forget)
      this.drainOutbox();

      return { ok: true };
    }

    async drainOutbox(): Promise<void> {
      // Prevent concurrent drains (second message arriving mid-flight would re-process same rows)
      if (this.draining) return;
      this.draining = true;

      try {
        await this.drainOutboxInner();
      } finally {
        this.draining = false;
      }
    }

    async drainOutboxInner(): Promise<void> {
      const MAX_ATTEMPTS = 3;
      const rows = this.ctx.storage.sql
        .exec("SELECT id, payload, attempts FROM outbox WHERE status = 'pending' ORDER BY created_at")
        .toArray();

      for (const row of rows) {
        const entry = row as {
          id: string;
          payload: string;
          attempts: number;
        };
        const payload: unknown = JSON.parse(entry.payload);

        try {
          await this.executeEffect(payload);

          // Mark as sent
          this.ctx.storage.sql.exec("UPDATE outbox SET status = 'sent' WHERE id = ?", entry.id);
        } catch (error) {
          const newAttempts = entry.attempts + 1;
          if (newAttempts >= MAX_ATTEMPTS) {
            // Move to failures
            this.ctx.storage.sql.exec(
              "INSERT INTO emission_failures (id, type, payload, error, failed_at) VALUES (?, ?, ?, ?, ?)",
              entry.id,
              "emit",
              entry.payload,
              error instanceof Error ? error.message : String(error),
              Date.now(),
            );
            this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", entry.id);
          } else {
            this.ctx.storage.sql.exec("UPDATE outbox SET attempts = ? WHERE id = ?", newAttempts, entry.id);
            // Schedule retry — store desired time, then use unified alarm scheduler
            const retryDelays = [1000, 5000, 25000];
            const delay = retryDelays[newAttempts - 1] ?? 25000;
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('outbox_retry_at', ?)",
              String(Date.now() + delay),
            );
            this.scheduleUnifiedAlarm();
          }
        }
      }
    }

    async executeEffect(payload: unknown): Promise<unknown> {
      if (typeof payload !== "object" || payload === null) return undefined;

      const effect = payload as Record<string, unknown>;

      if ("queue" in effect && typeof effect["queue"] === "string") {
        // Queue effect — call env binding
        const queueName = effect["queue"];
        const queueBinding = (this.env as Record<string, unknown>)[queueName];
        if (queueBinding && typeof queueBinding === "object" && "send" in queueBinding) {
          await (queueBinding as { send: (body: unknown) => Promise<void> }).send(effect["body"]);
        }
        return undefined;
      } else if ("fetch" in effect && typeof effect["fetch"] === "string") {
        // Fetch effect — check HTTP status, throw on failure
        const response = await fetch(effect["fetch"], {
          method: (effect["method"] as string) ?? "POST",
          body: effect["body"] ? JSON.stringify(effect["body"]) : null,
          headers: (effect["headers"] as Record<string, string>) ?? { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }
        // Return parsed response body
        try {
          return await response.json();
        } catch {
          return await response.text();
        }
      } else if ("actor" in effect && typeof effect["actor"] === "string") {
        // Actor RPC — use ref() to send message to another DO
        const targetType = effect["actor"];
        const targetId = effect["id"];
        const targetMessage = effect["message"];
        const targetPayload = effect["payload"];
        if (typeof targetId !== "string" || typeof targetMessage !== "string") {
          throw new Error(`Invalid actor RPC effect: missing id or message`);
        }
        const namespace = (this.env as Record<string, unknown>)[targetType.toUpperCase()];
        if (!namespace || typeof namespace !== "object" || !("idFromName" in namespace)) {
          throw new Error(`DO namespace "${targetType.toUpperCase()}" not found in env`);
        }
        const ns = namespace as {
          idFromName: (name: string) => { toString: () => string };
          get: (id: unknown) => { send: (c: string, ct: string, e: unknown) => Promise<unknown> };
        };
        const doId = ns.idFromName(targetId);
        const stub = ns.get(doId);
        await stub.send("system", "service", {
          type: targetMessage,
          ...(typeof targetPayload === "object" && targetPayload !== null
            ? (targetPayload as Record<string, unknown>)
            : {}),
        });
        return undefined;
      }
      return undefined;
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
    }

    async fetch(request: Request): Promise<Response> {
      // WebSocket upgrade
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      // --- Caller identity resolution ---
      // Priority 1: Identity headers (Worker-trust model).
      //   The Worker authenticates the caller and stamps identity via withCallerIdentity().
      //   SECURITY: withCallerIdentity scrubs inbound headers before setting verified ones.
      //   Workers MUST call withCallerIdentity() before forwarding to the DO — forwarding
      //   raw client requests (stub.fetch(request)) allows header spoofing.
      //   CORS/Origin validation is handled at the Worker level (e.g., Hono cors() middleware), not inside the actor.
      // Priority 2: JWT token in Sec-WebSocket-Protocol (backward compat / external clients).
      const headerCallerId = request.headers.get(CALLER_ID_HEADER);
      const headerCallerType = request.headers.get(CALLER_TYPE_HEADER);

      // Extract token subprotocol (used as fallback if headers absent)
      const protocols = request.headers.get("Sec-WebSocket-Protocol") ?? "";
      const tokenProtocol = protocols
        .split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith("token."));

      let callerInfo: { caller: string; callerType: "user" | "service" };

      if (headerCallerId && headerCallerType) {
        // Header-based auth: Worker already authenticated the caller.
        if (headerCallerType !== "user" && headerCallerType !== "service") {
          return new Response("Invalid caller type", { status: 401 });
        }
        callerInfo = { caller: headerCallerId, callerType: headerCallerType };
      } else if (tokenProtocol) {
        // Token fallback: validate JWT from subprotocol.
        const token = tokenProtocol.slice("token.".length);
        const secret = (this.env as Record<string, unknown>)["ACTOR_KIT_SECRET"];
        if (typeof secret !== "string") {
          return new Response("Server misconfigured", { status: 500 });
        }

        // Load state to restore actorId for JWT validation
        await this.loadState();
        if (!this.initialized) {
          return new Response("Actor requires input — call spawn({ input }) before connecting", { status: 404 });
        }

        const actorId = this.actorId ?? this.ctx.id.toString();

        try {
          callerInfo = await getCallerFromToken(token, actorName, actorId, secret);
        } catch {
          return new Response("Invalid token", { status: 401 });
        }
      } else {
        return new Response("Missing caller identity", { status: 401 });
      }

      // Load state if not already loaded (header-based auth skips the token path)
      await this.loadState();
      if (!this.initialized) {
        return new Response("Actor requires input — call spawn({ input }) before connecting", { status: 404 });
      }

      const role = resolveRole(def.roles, this.state, callerInfo.caller, { callerType: callerInfo.callerType });
      if (role === null) {
        return new Response("Forbidden", { status: 403 });
      }

      // Detect binary support:
      // - Token-based connections (SDK direct) always support binary
      // - Header-based connections (Worker-forwarded) support binary only if opted in
      const clientSupportsBinary = tokenProtocol ? true : request.headers.get(BINARY_SUPPORT_HEADER) === "1";

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Store caller metadata as WebSocket tags so they survive DO hibernation.
      // Tags: ["caller:{id}", "callerType:{type}"]
      const tags = [`caller:${callerInfo.caller}`, `callerType:${callerInfo.callerType}`];
      if (clientSupportsBinary) tags.push("binary");
      this.ctx.acceptWebSocket(server, tags);
      this.connections.set(server, { caller: callerInfo.caller, callerType: callerInfo.callerType });
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
          emit: (effect: Effect) => connectOutbox.emit(effect),
        };
        const nextState = def.lifecycle.connect(
          this.state,
          { caller: callerInfo.caller, callerType: callerInfo.callerType },
          connectCtx,
        );
        if (nextState instanceof Promise) {
          throw new Error("lifecycle.connect returned a Promise. Handlers must be synchronous.");
        }
        if (nextState !== this.state) {
          this.state = nextState;
          const outboxEntries = connectOutbox.toEntries();
          this.ctx.storage.transactionSync(() => {
            this.persistState();
            if (outboxEntries.length > 0) this.persistOutbox(outboxEntries);
          });
          this.broadcastViews();
          if (outboxEntries.length > 0) this.drainOutbox();
        }
      }

      // Start tick if defined and not already running
      this.startTick();

      const responseHeaders: HeadersInit = {};
      if (tokenProtocol) {
        // Echo back the selected subprotocol — required by WebSocket spec
        responseHeaders["Sec-WebSocket-Protocol"] = tokenProtocol;
      }

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: responseHeaders,
      });
    }

    async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
      if (typeof data !== "string") return;

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
          ws.send(JSON.stringify({ type: "__error", message: event.type, error: result.error }));
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
      const info = this.getCallerFromWs(ws);
      if (!info) return;
      const { caller } = info;

      this.connections.delete(ws);
      this.previousViews.delete(ws);
      this.previousViewData.delete(ws);
      this.connectionChecksums.delete(ws);
      this.supportsBinary.delete(ws);

      // Run lifecycle.disconnect if defined
      if (def.lifecycle?.disconnect) {
        const disconnectOutbox = createOutbox();
        const disconnectCtx = {
          caller,
          callerType: info.callerType,
          env: this.env,
          emit: (effect: Effect) => disconnectOutbox.emit(effect),
        };
        const nextState = def.lifecycle.disconnect(this.state, { caller, callerType: info.callerType }, disconnectCtx);
        if (nextState instanceof Promise) {
          throw new Error("lifecycle.disconnect returned a Promise. Handlers must be synchronous.");
        }
        if (nextState !== this.state) {
          this.state = nextState;
          const outboxEntries = disconnectOutbox.toEntries();
          this.ctx.storage.transactionSync(() => {
            this.persistState();
            if (outboxEntries.length > 0) this.persistOutbox(outboxEntries);
          });
          this.broadcastViews();
          if (outboxEntries.length > 0) this.drainOutbox();
        }
      }

      // Stop tick if no connections remain
      if (this.connections.size === 0) {
        this.stopTick();
      }
    }

    // --- DO Alarms (after timers) ---

    scheduleAfterTimers(): void {
      if (!def.after) return;

      const createdAt = Date.now();

      // Store creation time so all timers are relative to it (prevents drift)
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('after_created_at', ?)",
        String(createdAt),
      );

      // Find the soonest timer and store it, then use unified scheduler
      this.pickNextAfterTimer(createdAt);
      this.scheduleUnifiedAlarm();
    }

    pickNextAfterTimer(createdAt: number, excludeKeys?: Set<string>): void {
      if (!def.after) return;

      let soonestAbsoluteTime = Infinity;
      let soonestKey: string | undefined;

      for (const [durationStr] of Object.entries(def.after)) {
        if (excludeKeys?.has(durationStr)) continue;
        const ms = parseDuration(durationStr);
        const absoluteTime = createdAt + ms;
        if (absoluteTime < soonestAbsoluteTime) {
          soonestAbsoluteTime = absoluteTime;
          soonestKey = durationStr;
        }
      }

      if (soonestKey !== undefined) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('scheduled_alarm', ?)",
          soonestKey,
        );
      } else {
        this.ctx.storage.sql.exec("DELETE FROM actor_meta WHERE key = 'scheduled_alarm'");
      }
    }

    async alarm(): Promise<void> {
      await this.loadState();
      if (!this.initialized) return;

      // Find which timer fired
      const rows = this.ctx.storage.sql.exec("SELECT value FROM actor_meta WHERE key = 'scheduled_alarm'").toArray();
      const scheduledKey = (rows[0] as { value: string } | undefined)?.value;

      if (scheduledKey && def.after) {
        const handler = def.after[scheduledKey];
        if (typeof handler === "function") {
          const nextState = handler(this.state);
          if (nextState instanceof Promise) {
            throw new Error(`after["${scheduledKey}"] returned a Promise. Handlers must be synchronous.`);
          }
          if (nextState !== this.state) {
            this.state = nextState;

            // Advance sequential state tracker if handler set __actorState
            if (this.stateTracker && typeof this.state === "object" && this.state !== null) {
              const stateObj = this.state as Record<string, unknown>;
              if (typeof stateObj["__actorState"] === "string") {
                const newStateName = stateObj["__actorState"];
                if ("current" in this.stateTracker) {
                  this.stateTracker = { current: newStateName };
                }
              }
            }

            this.persistState();
            this.broadcastViews();
          }
        }

        // Track fired timer and schedule next (drift-free)
        this.ctx.storage.sql.exec("DELETE FROM actor_meta WHERE key = 'scheduled_alarm'");

        // Persist fired key so it's never re-picked
        const firedRows = this.ctx.storage.sql
          .exec("SELECT value FROM actor_meta WHERE key = 'after_fired_keys'")
          .toArray();
        const previouslyFired =
          firedRows.length > 0 ? (JSON.parse((firedRows[0] as { value: string }).value) as string[]) : [];
        const allFired = [...previouslyFired, scheduledKey];
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('after_fired_keys', ?)",
          JSON.stringify(allFired),
        );

        const createdRows = this.ctx.storage.sql
          .exec("SELECT value FROM actor_meta WHERE key = 'after_created_at'")
          .toArray();
        const createdAt = Number((createdRows[0] as { value: string } | undefined)?.value ?? Date.now());
        this.pickNextAfterTimer(createdAt, new Set(allFired));
      }

      // Check for outbox retry
      const retryRows = this.ctx.storage.sql
        .exec("SELECT value FROM actor_meta WHERE key = 'outbox_retry_at'")
        .toArray();
      const retryAt = retryRows.length > 0 ? Number((retryRows[0] as { value: string }).value) : undefined;
      if (retryAt !== undefined && Date.now() >= retryAt) {
        this.ctx.storage.sql.exec("DELETE FROM actor_meta WHERE key = 'outbox_retry_at'");
        this.drainOutbox();
      }

      // Re-schedule unified alarm for any remaining timers/retries
      this.scheduleUnifiedAlarm();
    }

    // --- Unified alarm scheduler ---
    // DOs only have one alarm slot. This method picks the soonest needed
    // alarm across after timers and outbox retries.

    scheduleUnifiedAlarm(): void {
      let soonestTime = Infinity;

      // Check after timers
      if (def.after) {
        const createdRows = this.ctx.storage.sql
          .exec("SELECT value FROM actor_meta WHERE key = 'after_created_at'")
          .toArray();
        const createdAt = createdRows.length > 0 ? Number((createdRows[0] as { value: string }).value) : undefined;

        if (createdAt !== undefined) {
          const scheduledRows = this.ctx.storage.sql
            .exec("SELECT value FROM actor_meta WHERE key = 'scheduled_alarm'")
            .toArray();
          const scheduledKey = scheduledRows.length > 0 ? (scheduledRows[0] as { value: string }).value : undefined;

          if (scheduledKey) {
            const ms = parseDuration(scheduledKey);
            const absoluteTime = createdAt + ms;
            if (absoluteTime < soonestTime) {
              soonestTime = absoluteTime;
            }
          }
        }
      }

      // Check outbox retry
      const retryRows = this.ctx.storage.sql
        .exec("SELECT value FROM actor_meta WHERE key = 'outbox_retry_at'")
        .toArray();
      if (retryRows.length > 0) {
        const retryAt = Number((retryRows[0] as { value: string }).value);
        if (retryAt < soonestTime) {
          soonestTime = retryAt;
        }
      }

      // Schedule the soonest alarm
      if (soonestTime < Infinity) {
        const delay = Math.max(0, soonestTime - Date.now());
        this.ctx.storage.setAlarm(Date.now() + delay);
      }
    }

    // --- Tick (game loop) ---

    tickInterval: ReturnType<typeof setInterval> | undefined = undefined;
    lastTickPersist = 0;
    tickRunning = false; // Reentrancy guard for async tick handlers

    startTick(): void {
      if (!def.tick || this.tickInterval !== undefined) return;

      this.tickInterval = setInterval(async () => {
        if (!this.initialized) return;
        if (this.tickRunning) return; // Skip if previous tick is still running
        this.tickRunning = true;

        try {
          const handler = def.tick?.handler;
          if (typeof handler !== "function") return;

          const nextState = handler(this.state);
          if (nextState instanceof Promise) {
            throw new Error("tick.handler returned a Promise. Handlers must be synchronous.");
          }
          if (nextState !== this.state) {
            this.state = nextState;

            // Throttle persistence to max 1/second for ticks
            const now = Date.now();
            if (now - this.lastTickPersist >= 1000) {
              this.persistState();
              this.lastTickPersist = now;
            }

            this.broadcastViews();
          }
        } finally {
          this.tickRunning = false;
        }
      }, def.tick.frequency);
    }

    stopTick(): void {
      if (this.tickInterval !== undefined) {
        clearInterval(this.tickInterval);
        this.tickInterval = undefined;

        // Persist final state on tick stop
        if (this.initialized) {
          this.persistState();
        }
      }
    }
  };
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
