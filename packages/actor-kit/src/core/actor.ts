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
import type { z } from "zod";
import { resolveRole } from "../runtime/roles";
import { routeMessage } from "../runtime/message-router";
import { resolveMessagesForState } from "../runtime/states";
import { createOutbox, type OutboxEntry } from "../runtime/outbox";
import { getCallerFromToken } from "../auth/auth";
import type { MessageContext, Effect, RequestConfig } from "./message";
import { parseDuration } from "../runtime/timers";

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
  guard?(state: unknown): boolean; // bivariant method signature
}

interface ActorDef {
  input: z.ZodType;
  init(input: unknown): unknown; // bivariant
  version?: number;
  initial?: string;
  roles: Record<string, {
    // bivariant method signature for role predicates
    (state: unknown, caller: string, claims: { callerType: "user" | "service" }): boolean;
  }>;
  messages?: Record<string, Record<string, ActorMessageSlot>>;
  states?: Record<string, {
    messages: Record<string, Record<string, ActorMessageSlot>>;
  }> | {
    parallel: true;
    regions: Record<string, {
      initial: string;
      states: Record<string, {
        messages: Record<string, Record<string, ActorMessageSlot>>;
      }>;
    }>;
  };
  views: Record<string, {
    fn(state: unknown, caller: string): unknown; // bivariant
  }>;
  on?: Record<string, {
    (state: unknown, ...args: unknown[]): unknown | Promise<unknown>; // bivariant
  }>;
  after?: Record<string, {
    (state: unknown): unknown | Promise<unknown>;
  }>;
  tick?: {
    frequency: number;
    handler(state: unknown): unknown | Promise<unknown>;
  };
  observe?: {
    onTransition?(prevState: unknown, nextState: unknown, event: { type: string }, ctx: { caller: string; role: string }): void;
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
    on_done TEXT,
    on_error TEXT,
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
) {
  return class ActorInstance extends DurableObject {
    private state: unknown = undefined;
    private actorId: string | undefined = undefined; // Human-readable ID (the name passed to idFromName)
    private stateTracker: Record<string, string> | { current: string } | undefined = undefined;
    private initialized = false;
    private version: number;
    // Keyed by WebSocket (not caller) to support multi-tab/multi-device
    private connections = new Map<WebSocket, { caller: string; callerType: "user" | "service" }>();
    private previousViews = new Map<WebSocket, string>(); // JSON string of last sent view
    private draining = false; // Prevents concurrent outbox drains

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.version = def.version ?? 1;
    }

    private async ensureTables(): Promise<void> {
      this.ctx.storage.sql.exec(CREATE_TABLES_SQL);
    }

    private async loadState(): Promise<void> {
      if (this.initialized) return;

      await this.ensureTables();

      const rows = this.ctx.storage.sql
        .exec("SELECT state, version, state_tracker, actor_id FROM snapshots WHERE id = 1")
        .toArray();

      if (rows.length > 0 && rows[0] !== undefined) {
        const row = rows[0] as { state: string; version: number; state_tracker: string | null; actor_id: string | null };
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
      }
    }

    private persistState(): void {
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

    private persistOutbox(entries: OutboxEntry[]): void {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          "INSERT INTO outbox (id, type, payload, status, attempts, on_done, on_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          entry.id,
          entry.type,
          JSON.stringify(entry.payload),
          entry.status,
          entry.attempts,
          entry.onDone ?? null,
          entry.onError ?? null,
          entry.createdAt,
        );
      }
    }

    private computeChecksum(json: string): string {
      // Simple hash for Phase 1 — replace with xxhash64 in Phase 2
      let h = 0;
      for (let i = 0; i < json.length; i++) {
        h = ((h << 5) - h + json.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(16);
    }

    async spawn(input: { actorId?: string; caller: string; callerType: "user" | "service"; input: unknown }): Promise<void> {
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
      this.state = def.init(parsed.data);
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

    async send(caller: string, callerType: "user" | "service", event: { type: string; [key: string]: unknown }): Promise<{ ok: boolean; error?: string }> {
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
      const messages = resolveMessagesForState(
        def.messages,
        def.states,
        this.stateTracker,
      );
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
        request: (config: RequestConfig) => outbox.request(config),
      };

      // Route message
      const result = await routeMessage(messages, role, this.state, event, ctx);

      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      // Observability hook
      const prevState = this.state;

      // Update state
      this.state = result.state;

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

    private async drainOutbox(): Promise<void> {
      // Prevent concurrent drains (second message arriving mid-flight would re-process same rows)
      if (this.draining) return;
      this.draining = true;

      try {
        await this.drainOutboxInner();
      } finally {
        this.draining = false;
      }
    }

    private async drainOutboxInner(): Promise<void> {
      const MAX_ATTEMPTS = 3;
      const rows = this.ctx.storage.sql
        .exec("SELECT id, type, payload, attempts, on_done, on_error FROM outbox WHERE status = 'pending' ORDER BY created_at")
        .toArray();

      for (const row of rows) {
        const entry = row as { id: string; type: string; payload: string; attempts: number; on_done: string | null; on_error: string | null };
        const payload: unknown = JSON.parse(entry.payload);

        try {
          await this.executeEffect(payload);

          // Mark as sent
          this.ctx.storage.sql.exec("UPDATE outbox SET status = 'sent' WHERE id = ?", entry.id);

          // If this was a request with onDone, deliver the callback
          if (entry.on_done && entry.type === "request") {
            const onHandler = def.on?.[entry.on_done];
            if (typeof onHandler === "function") {
              const nextState = await onHandler(this.state, {});
              if (nextState !== this.state) {
                this.state = nextState;
                this.persistState();
                this.broadcastViews();
              }
            }
          }
        } catch (error) {
          const newAttempts = entry.attempts + 1;
          if (newAttempts >= MAX_ATTEMPTS) {
            // Move to failures
            this.ctx.storage.sql.exec(
              "INSERT INTO emission_failures (id, type, payload, error, failed_at) VALUES (?, ?, ?, ?, ?)",
              entry.id, entry.type, entry.payload,
              error instanceof Error ? error.message : String(error),
              Date.now(),
            );
            this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", entry.id);

            // Deliver onError callback if this was a request
            if (entry.on_error && entry.type === "request") {
              const onHandler = def.on?.[entry.on_error];
              if (typeof onHandler === "function") {
                const nextState = await onHandler(this.state, { message: error instanceof Error ? error.message : String(error) });
                if (nextState !== this.state) {
                  this.state = nextState;
                  this.persistState();
                  this.broadcastViews();
                }
              }
            }
          } else {
            this.ctx.storage.sql.exec("UPDATE outbox SET attempts = ? WHERE id = ?", newAttempts, entry.id);
            // Schedule retry via DO Alarm — exponential backoff: 1s, 5s, 25s
            const retryDelays = [1000, 5000, 25000];
            const delay = retryDelays[newAttempts - 1] ?? 25000;
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('outbox_retry', ?)",
              String(Date.now() + delay),
            );
            this.ctx.storage.setAlarm(Date.now() + delay);
          }
        }
      }
    }

    private async executeEffect(payload: unknown): Promise<void> {
      if (typeof payload !== "object" || payload === null) return;

      const effect = payload as Record<string, unknown>;

      if ("queue" in effect && typeof effect["queue"] === "string") {
        // Queue effect — call env binding
        const queueName = effect["queue"];
        const queueBinding = (this.env as Record<string, unknown>)[queueName];
        if (queueBinding && typeof queueBinding === "object" && "send" in queueBinding) {
          await (queueBinding as { send: (body: unknown) => Promise<void> }).send(effect["body"]);
        }
      } else if ("fetch" in effect && typeof effect["fetch"] === "string") {
        // Fetch effect — check HTTP status, throw on failure
        const response = await fetch(effect["fetch"], {
          method: (effect["method"] as string) ?? "POST",
          body: effect["body"] ? JSON.stringify(effect["body"]) : undefined,
          headers: (effect["headers"] as Record<string, string>) ?? { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
        }
      } else if ("actor" in effect && typeof effect["actor"] === "string") {
        // Actor RPC effect — not implemented in Phase 1, would use ref()
        // For now, log and skip
      }
    }

    async getSnapshot(caller: string, callerType: "user" | "service"): Promise<{ checksum: string; snapshot: unknown; role: string }> {
      await this.loadState();
      if (!this.initialized) {
        throw new Error("Actor not initialized — call spawn() first");
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

    private getCallerFromWs(ws: WebSocket): { caller: string; callerType: "user" | "service" } | null {
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
      // Re-populate in-memory map
      this.connections.set(ws, { caller, callerType });
      return { caller, callerType };
    }

    private broadcastViews(): void {
      // Use getWebSockets() to get all connected sockets (survives hibernation)
      const allSockets = this.ctx.getWebSockets();
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
          const json = JSON.stringify(viewData);

          // Check if view changed PER CONNECTION (not per caller)
          const prevJson = this.previousViews.get(ws);
          if (json === prevJson) continue;

          this.previousViews.set(ws, json);
          ws.send(JSON.stringify({ type: "snapshot", role, data: viewData }));
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

      // Extract JWT from Sec-WebSocket-Protocol
      const protocols = request.headers.get("Sec-WebSocket-Protocol") ?? "";
      const tokenProtocol = protocols.split(",").map((p) => p.trim()).find((p) => p.startsWith("token."));
      if (!tokenProtocol) {
        return new Response("Missing auth token", { status: 401 });
      }

      const token = tokenProtocol.slice("token.".length);
      const secret = (this.env as Record<string, unknown>)["ACTOR_KIT_SECRET"];
      if (typeof secret !== "string") {
        return new Response("Server misconfigured", { status: 500 });
      }

      // Load state FIRST so this.actorId is restored from SQLite
      // (otherwise after hibernation, actorId is undefined and JWT check fails)
      await this.loadState();
      if (!this.initialized) {
        return new Response("Actor not initialized", { status: 404 });
      }

      // Validate token against the stored actor identity.
      const actorId = this.actorId ?? this.ctx.id.toString();

      let callerInfo: { caller: string; callerType: "user" | "service" };
      try {
        callerInfo = await getCallerFromToken(token, actorName, actorId, secret);
      } catch {
        return new Response("Invalid token", { status: 401 });
      }

      const role = resolveRole(def.roles, this.state, callerInfo.caller, { callerType: callerInfo.callerType });
      if (role === null) {
        return new Response("Forbidden", { status: 403 });
      }

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Store caller metadata as WebSocket tags so they survive DO hibernation.
      // Tags: ["caller:{id}", "callerType:{type}"]
      this.ctx.acceptWebSocket(server, [
        `caller:${callerInfo.caller}`,
        `callerType:${callerInfo.callerType}`,
      ]);
      this.connections.set(server, { caller: callerInfo.caller, callerType: callerInfo.callerType });

      // Send initial snapshot
      const viewDef = def.views[role];
      if (viewDef) {
        const viewData = viewDef.fn(this.state, callerInfo.caller);
        const json = JSON.stringify(viewData);
        this.previousViews.set(server, json);
        server.send(JSON.stringify({ type: "snapshot", role, data: viewData }));
      }

      // Run on.connect if defined
      if (def.on?.["connect"]) {
        const nextState = await def.on["connect"](this.state, callerInfo.caller);
        if (nextState !== this.state) {
          this.state = nextState;
          this.persistState();
          this.broadcastViews();
        }
      }

      // Start tick if defined and not already running
      this.startTick();

      return new Response(null, {
        status: 101,
        webSocket: client,
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
        const result = await this.send(caller, callerType, event);
        // Send error frame back to client if message was rejected
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "__error", message: event.type, error: result.error }));
        }
      } catch {
        ws.send(JSON.stringify({ type: "__error", detail: "Invalid message" }));
      }
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
      const info = this.getCallerFromWs(ws);
      if (!info) return;
      const { caller } = info;

      this.connections.delete(ws);
      this.previousViews.delete(ws);

      // Run on.disconnect if defined
      if (def.on?.["disconnect"]) {
        const nextState = await def.on["disconnect"](this.state, caller);
        if (nextState !== this.state) {
          this.state = nextState;
          this.persistState();
          this.broadcastViews();
        }
      }

      // Stop tick if no connections remain
      if (this.connections.size === 0) {
        this.stopTick();
      }
    }

    // --- DO Alarms (after timers) ---

    private scheduleAfterTimers(): void {
      if (!def.after) return;

      // Find the soonest timer and schedule it
      let soonestMs = Infinity;
      let soonestKey: string | undefined;

      for (const [durationStr] of Object.entries(def.after)) {
        const ms = parseDuration(durationStr);
        if (ms < soonestMs) {
          soonestMs = ms;
          soonestKey = durationStr;
        }
      }

      if (soonestKey !== undefined && soonestMs < Infinity) {
        // Store which timer is scheduled so alarm() knows which handler to run
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('scheduled_alarm', ?)",
          soonestKey,
        );
        this.ctx.storage.setAlarm(Date.now() + soonestMs);
      }
    }

    async alarm(): Promise<void> {
      await this.loadState();
      if (!this.initialized) return;

      // Find which timer fired
      const rows = this.ctx.storage.sql
        .exec("SELECT value FROM actor_meta WHERE key = 'scheduled_alarm'")
        .toArray();
      const scheduledKey = (rows[0] as { value: string } | undefined)?.value;

      if (scheduledKey && def.after) {
        const handler = def.after[scheduledKey];
        if (typeof handler === "function") {
          const nextState = await handler(this.state);
          if (nextState !== this.state) {
            this.state = nextState;
            this.persistState();
            this.broadcastViews();
          }
        }

        // Clean up and schedule next timer (excluding the one that just fired)
        this.ctx.storage.sql.exec("DELETE FROM actor_meta WHERE key = 'scheduled_alarm'");

        // Schedule remaining timers
        let soonestMs = Infinity;
        let soonestKey: string | undefined;
        for (const [durationStr] of Object.entries(def.after)) {
          if (durationStr === scheduledKey) continue;
          const ms = parseDuration(durationStr);
          if (ms < soonestMs) {
            soonestMs = ms;
            soonestKey = durationStr;
          }
        }
        if (soonestKey !== undefined && soonestMs < Infinity) {
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO actor_meta (key, value) VALUES ('scheduled_alarm', ?)",
            soonestKey,
          );
          this.ctx.storage.setAlarm(Date.now() + soonestMs);
        }
      }

      // Check for outbox retry alarm
      const retryRows = this.ctx.storage.sql
        .exec("SELECT value FROM actor_meta WHERE key = 'outbox_retry'")
        .toArray();
      if (retryRows.length > 0) {
        this.ctx.storage.sql.exec("DELETE FROM actor_meta WHERE key = 'outbox_retry'");
        this.drainOutbox();
      }
    }

    // --- Tick (game loop) ---

    private tickInterval: ReturnType<typeof setInterval> | undefined = undefined;
    private lastTickPersist = 0;

    private startTick(): void {
      if (!def.tick || this.tickInterval !== undefined) return;

      this.tickInterval = setInterval(async () => {
        if (!this.initialized) return;
        const handler = def.tick?.handler;
        if (typeof handler !== "function") return;

        const nextState = await handler(this.state);
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
      }, def.tick.frequency);
    }

    private stopTick(): void {
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
