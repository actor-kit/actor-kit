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

// --- Actor definition ---

// Runtime actor definition — uses structural types that erase generics.
// Type safety is enforced at the definition site (message(), view(), etc.),
// not at the runtime level. The DO class just needs schemas, handlers, and predicates.
interface ActorDef {
  input: z.ZodType;
  init: (input: unknown) => unknown;
  version?: number;
  initial?: string; // Initial state name for sequential states
  roles: Record<string, (state: unknown, caller: string, claims: { callerType: "user" | "service" }) => boolean>;
  messages?: Record<string, Record<string, {
    readonly schema: z.ZodType;
    readonly handler: Function;
    readonly guard: ((state: unknown) => boolean) | undefined;
  }>>;
  states?: Record<string, {
    messages: Record<string, Record<string, {
      readonly schema: z.ZodType;
      readonly handler: Function;
      readonly guard: ((state: unknown) => boolean) | undefined;
    }>>;
  }> | {
    parallel: true;
    regions: Record<string, {
      initial: string;
      states: Record<string, {
        messages: Record<string, Record<string, {
          readonly schema: z.ZodType;
          readonly handler: Function;
          readonly guard: ((state: unknown) => boolean) | undefined;
        }>>;
      }>;
    }>;
  };
  views: Record<string, {
    readonly fn: (state: unknown, caller: string) => unknown;
  }>;
  on?: Record<string, (state: unknown, ...args: unknown[]) => unknown | Promise<unknown>>;
  migrate?: (persisted: unknown, fromVersion: number) => unknown;
  serialize?: (state: unknown) => unknown;
  restore?: (serialized: unknown) => unknown;
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
  _name: string,
  def: ActorDef,
) {
  return class ActorInstance extends DurableObject {
    private state: unknown = undefined;
    private stateTracker: Record<string, string> | { current: string } | undefined = undefined;
    private initialized = false;
    private version: number;
    private connections = new Map<string, { ws: WebSocket; callerType: "user" | "service" }>();
    private previousViews = new Map<string, unknown>();

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
        .exec("SELECT state, version, state_tracker FROM snapshots WHERE id = 1")
        .toArray();

      if (rows.length > 0 && rows[0] !== undefined) {
        const row = rows[0] as { state: string; version: number; state_tracker: string | null };
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

        this.initialized = true;
      }
    }

    private persistState(): void {
      const serialized = def.serialize ? def.serialize(this.state) : this.state;
      const json = JSON.stringify(serialized);
      const checksum = this.computeChecksum(json);
      const stateTrackerJson = this.stateTracker ? JSON.stringify(this.stateTracker) : null;

      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO snapshots (id, version, state, state_tracker, checksum, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
        this.version,
        json,
        stateTrackerJson,
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

    async spawn(input: { caller: string; callerType: "user" | "service"; input: unknown }): Promise<void> {
      await this.loadState();
      if (this.initialized) return; // Idempotent

      // Validate input
      const parsed = def.input.safeParse(input.input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }

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

      // Update state
      this.state = result.state;

      // Persist state + outbox atomically
      this.ctx.storage.transactionSync(() => {
        this.persistState();
        this.persistOutbox(outbox.toEntries());
      });

      // Broadcast views to connected clients
      this.broadcastViews();

      return { ok: true };
    }

    async getSnapshot(caller: string, callerType: "user" | "service"): Promise<{ checksum: string; snapshot: unknown; role: string }> {
      await this.loadState();

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

    private broadcastViews(): void {
      for (const [caller, conn] of this.connections) {
        try {
          const role = resolveRole(def.roles, this.state, caller, { callerType: conn.callerType });
          if (role === null) continue;

          const viewDef = def.views[role];
          if (viewDef === undefined) continue;

          const viewData = viewDef.fn(this.state, caller);
          const json = JSON.stringify(viewData);

          // Check if view changed (simple JSON equality for Phase 1)
          const prevJson = this.previousViews.get(caller);
          if (json === prevJson) continue;

          this.previousViews.set(caller, json);
          conn.ws.send(JSON.stringify({ type: "snapshot", role, data: viewData }));
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

      // Validate token — we need actorType and actorId from somewhere
      // For now, extract from the URL path: /api/{actorType}/{actorId}
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const actorType = parts[1] ?? "";
      const actorId = parts[2] ?? "";

      let callerInfo: { caller: string; callerType: "user" | "service" };
      try {
        callerInfo = await getCallerFromToken(token, actorType, actorId, secret);
      } catch {
        return new Response("Invalid token", { status: 401 });
      }

      // Check role
      await this.loadState();
      const role = resolveRole(def.roles, this.state, callerInfo.caller, { callerType: callerInfo.callerType });
      if (role === null) {
        return new Response("Forbidden", { status: 403 });
      }

      // Create WebSocket pair
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      this.ctx.acceptWebSocket(server);
      this.connections.set(callerInfo.caller, { ws: server, callerType: callerInfo.callerType });

      // Send initial snapshot
      const viewDef = def.views[role];
      if (viewDef) {
        const viewData = viewDef.fn(this.state, callerInfo.caller);
        const json = JSON.stringify(viewData);
        this.previousViews.set(callerInfo.caller, json);
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

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
      if (typeof data !== "string") return;

      // Find caller for this WebSocket
      let caller: string | undefined;
      let callerType: "user" | "service" = "user";
      for (const [c, conn] of this.connections) {
        if (conn.ws === ws) {
          caller = c;
          callerType = conn.callerType;
          break;
        }
      }
      if (!caller) return;

      try {
        const event = JSON.parse(data) as { type: string; [key: string]: unknown };
        await this.send(caller, callerType, event);
      } catch {
        ws.send(JSON.stringify({ type: "__error", detail: "Invalid message" }));
      }
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
      let caller: string | undefined;
      for (const [c, conn] of this.connections) {
        if (conn.ws === ws) {
          caller = c;
          break;
        }
      }
      if (!caller) return;

      this.connections.delete(caller);
      this.previousViews.delete(caller);

      // Run on.disconnect if defined
      if (def.on?.["disconnect"]) {
        const nextState = await def.on["disconnect"](this.state, caller);
        if (nextState !== this.state) {
          this.state = nextState;
          this.persistState();
          this.broadcastViews();
        }
      }
    }
  };
}
