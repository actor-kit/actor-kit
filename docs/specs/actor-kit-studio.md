# Actor Kit Studio — Specification

## Goal

A production-ready introspection and debugging tool for actor-kit. Developers connect to running actors and see a live timeline of every state mutation, current state, connections, outbox, links, and view projections.

## Package

`@actor-kit/studio` — single package containing:
- `actorKitStudio()` middleware (Worker-side)
- `StudioRegistry` Durable Object class
- Timeline instrumentation (wired into `persistState()`)
- Bundled React SPA (served by middleware)

## Architecture

```
┌─────────────┐     /__studio/*      ┌──────────────────┐
│  Studio UI  │◄───────────────────►│  actorKitStudio() │
│  (React SPA)│     WebSocket +      │   middleware      │
└─────────────┘     HTTP API         └────────┬─────────┘
                                              │ RPC
                                    ┌─────────▼──────────┐
                                    │  Target Actor DO    │
                                    │  __inspect()        │
                                    │  __getTimeline()    │
                                    │  studio WebSocket   │
                                    └─────────┬──────────┘
                                              │ RPC (fire & forget)
                                    ┌─────────▼──────────┐
                                    │  StudioRegistry DO  │
                                    │  SQLite actor index │
                                    └────────────────────┘
```

## Setup

### Developer's wrangler.toml

No KV namespaces required. The `StudioRegistry` is a Durable Object discovered via `ctx.exports`.

### Developer's worker.ts

```typescript
import { actorKitStudio, StudioRegistry } from "@actor-kit/studio";

// Export the registry DO class
export { StudioRegistry };

export default {
  fetch(request, env, ctx) {
    // Studio middleware — intercepts /__studio/* routes
    const studio = actorKitStudio(request, env, ctx);
    if (studio) return studio;

    // ... normal app routing
  }
};
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ACTOR_KIT_STUDIO_SECRET` | Prod only | Secret key for API auth. Set via `wrangler secret put`. |

## Authentication

### Local development (`wrangler dev`)

No auth required. If `ACTOR_KIT_STUDIO_SECRET` is not set and the request is from localhost, all studio routes are open.

### Production

Every `/__studio/*` request must include `X-Actor-Kit-Studio-Key` header matching `ACTOR_KIT_STUDIO_SECRET`. The studio UI prompts for this key on first visit and stores it in localStorage.

If the secret is not configured in prod, the middleware returns `403` with an error message explaining setup.

Cloudflare WAF / Access can be layered on top for defense-in-depth (documented, not required).

## Actor Registry

### StudioRegistry Durable Object

A single DO instance with a SQLite table tracking all known actor instances.

```sql
CREATE TABLE actors (
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  last_active_at INTEGER NOT NULL,
  version INTEGER,
  connection_count INTEGER DEFAULT 0,
  PRIMARY KEY (actor_type, actor_id)
);
CREATE INDEX idx_actors_recency ON actors(last_active_at DESC);
CREATE INDEX idx_actors_type ON actors(actor_type, last_active_at DESC);
```

### Auto-registration

The `actor()` runtime detects `StudioRegistry` in `ctx.exports` on initialization. If present:

- **On `init()`**: INSERT into registry with `last_active_at = now`.
- **On state change**: touch `last_active_at` via fire-and-forget RPC, **debounced at 10 seconds** per actor instance. A timestamp that's 10s stale is acceptable for a dashboard sorted by recency.
- **On connect/disconnect**: update `connection_count`.

If the registry is not in `ctx.exports`, no registration occurs. Zero overhead for users who haven't set up the studio.

### Registry RPC API

```typescript
class StudioRegistry extends DurableObject {
  // Called by actors (fire-and-forget)
  touch(actorType: string, actorId: string, version: number): void;
  updateConnections(actorType: string, actorId: string, count: number): void;

  // Called by studio middleware
  listActors(opts: {
    type?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<ActorEntry[]>;

  getActorTypes(): Promise<string[]>;
}
```

## Timeline Instrumentation

### Instrumentation point

All state mutations flow through `persistState()`. The timeline is instrumented at this single chokepoint. Before `persistState()` is called, the runtime attaches a `MutationCause` describing what triggered the change.

### Mutation causes

Every timeline entry has a `cause` discriminated union:

```typescript
type MutationCause =
  | { type: "init" }
  | { type: "migrate"; fromVersion: number; toVersion: number }
  | { type: "message"; messageType: string; caller: string; callerType: "user" | "service"; role: string; payload: unknown }
  | { type: "lifecycle.connect"; caller: string; callerType: "user" | "service"; role: string }
  | { type: "lifecycle.disconnect"; caller: string; callerType: "user" | "service"; role: string }
  | { type: "service.onDone"; service: string; input: unknown; result: unknown }
  | { type: "service.onError"; service: string; input: unknown; error: string }
  | { type: "link.onUpdate"; sourceType: string; sourceId: string; viewData: unknown }
  | { type: "link.onError"; sourceType: string; sourceId: string; error: string }
  | { type: "link.onUnlink"; sourceType: string; sourceId: string };
```

### Timeline table (per-actor SQLite)

```sql
CREATE TABLE timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cause_type TEXT NOT NULL,
  cause_data TEXT NOT NULL,       -- JSON-serialized MutationCause (minus the type field)
  state_snapshot TEXT NOT NULL,   -- Full "after" state as JSON
  checksum TEXT NOT NULL,         -- State checksum after mutation
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_timeline_created ON timeline(created_at DESC);
```

### Retention

Ring buffer with configurable size, default 500 entries. After each INSERT:

```sql
DELETE FROM timeline WHERE id NOT IN (
  SELECT id FROM timeline ORDER BY created_at DESC LIMIT ?
);
```

Configurable via `actor("counter", { ...def, studio: { timelineSize: 1000 } })`.

### State diffs

Diffs are **not computed or stored in the DO**. The timeline stores full "after" snapshots. The studio UI computes `jsonDiff(entry[n-1].state, entry[n].state)` client-side for display. This keeps the hot path fast — one JSON.stringify + INSERT per mutation.

### Activation

Timeline instrumentation activates when `StudioRegistry` is detected in `ctx.exports`. Same detection as auto-registration. No flag needed — if you've added the studio package, you get instrumentation.

## Studio WebSocket Protocol

### Connection

The studio connects to an actor via WebSocket through the middleware:

```
ws://host/__studio/actors/:type/:id/ws
```

The middleware resolves the DO namespace via `ctx.exports`, stamps `withCallerIdentity(request, { callerId: "__studio", callerType: "service" })`, and forwards the upgrade.

### Role bypass

The actor runtime detects `callerId === "__studio"` (reserved) and **bypasses role evaluation entirely**. Studio connections do not appear in the actor's `connections` map, do not trigger `lifecycle.connect/disconnect`, and do not receive view projections.

Studio connections are tracked in a separate `studioConnections` set.

### Messages from DO → Studio

```typescript
// Initial payload on connect
type StudioSnapshot = {
  type: "studio.snapshot";
  state: unknown;                    // Current full state
  timeline: TimelineEntry[];         // Last N entries
  connections: ConnectionInfo[];     // Active WebSocket connections
  outbox: OutboxEntry[];             // Executions table contents
  links: LinkInfo[];                 // active_links + link_subscribers
  actorType: string;
  actorId: string;
  version: number;
};

// Pushed on every state mutation. `entry.id` is the persisted row id (the same
// id __getTimeline() returns): the UI keys rows and de-duplicates by it.
type StudioTimelineEntry = {
  type: "studio.timeline";
  entry: TimelineEntry;
};

// Pushed on connection change
type StudioConnectionChange = {
  type: "studio.connection";
  action: "connect" | "disconnect";
  connection: ConnectionInfo;
};

// Pushed on outbox status change
type StudioOutboxChange = {
  type: "studio.outbox";
  entry: OutboxEntry;
};
```

### Messages from Studio → DO

```typescript
// Request view computation for a specific role/caller
type StudioRequestView = {
  type: "studio.requestView";
  role: string;
  caller?: string;  // For perCaller views
};

// Response
type StudioViewResult = {
  type: "studio.view";
  role: string;
  caller?: string;
  data: unknown;
};
```

## Studio Middleware API

### HTTP Routes

All routes prefixed with `/__studio/`.

| Route | Method | Description |
|---|---|---|
| `/__studio/` | GET | Serve the SPA (index.html) |
| `/__studio/assets/*` | GET | Serve SPA static assets |
| `/__studio/api/actors` | GET | List actors from registry (query params: `type`, `search`, `limit`, `offset`) |
| `/__studio/api/actors/types` | GET | List distinct actor types |
| `/__studio/api/actors/:type/:id` | GET | Get actor snapshot via `__inspect()` RPC |
| `/__studio/api/actors/:type/:id/timeline` | GET | Get timeline entries via `__getTimeline()` RPC |
| `/__studio/actors/:type/:id/ws` | GET | WebSocket upgrade to actor's studio connection |

### Actor RPC Methods

Added to every actor DO by the `actor()` function:

```typescript
class ActorInstance extends DurableObject {
  // Studio RPC — returns current state + metadata
  __inspect(): Promise<{
    state: unknown;
    version: number;
    actorId: string;
    connections: ConnectionInfo[];
    outbox: OutboxEntry[];
    links: LinkInfo[];
  }>;

  // Studio RPC — returns timeline entries with cursor pagination
  __getTimeline(opts?: {
    limit?: number;
    before?: number;  // entry ID for cursor pagination
  }): Promise<{
    entries: TimelineEntry[];
    hasMore: boolean;
  }>;
}
```

## Studio UI

### Tech stack

- React 19
- TanStack Router
- TanStack Start (for SSR? TBD — may not need SSR for a bundled SPA)
- Tailwind CSS
- Bundled as static assets, served by middleware

### Pages

#### Dashboard (`/__studio/`)

- Actor list sorted by `last_active_at` DESC
- Filter dropdown by actor type
- Search input (searches actor ID)
- Each row: actor type badge, actor ID, last active (relative time), connection count
- Click row → actor detail page
- Manual "Connect to actor" input (type + ID), always shown — the registry is debounced and may be unavailable

#### Actor Detail (`/__studio/actors/:type/:id`)

**Connection behavior** (`ui/src/hooks/use-studio-ws.ts`, `ui/src/studio-state.ts`)
- Every frame and API response is parsed with Zod (`ui/src/protocol.ts`). A malformed frame shows an error banner; the last good data stays on screen.
- A dropped socket reconnects with backoff (0.5s doubling, capped at 10s). The new snapshot replaces the timeline, and live entries are de-duplicated by id.
- If the socket cannot open, the UI asks the HTTP API: 404 shows "not created yet" and keeps retrying (the page goes live once the actor exists); 401/403/400 show the error and stop; if the API answers, its data is shown ("Polling") while the socket keeps retrying.
- Leaving the page closes the socket and cancels retries. The actor answers the close frame (`webSocketClose` calls `ws.close`), so the browser socket doesn't stay in CLOSING.
- The UI keeps at most 500 timeline entries (the default ring size). Large arrays/objects render 100 children at a time; strings over 200 characters and diffs over 200 rows are truncated with a control to show more.

**State panel**
- Live-updating JSON tree view of current state
- Collapsible/expandable nodes
- Syntax highlighting

**Timeline panel**
- Chronological list, newest first
- Each entry shows:
  - Cause icon/badge (color-coded by type: message=blue, service=green, link=purple, lifecycle=gray)
  - Timestamp (relative + absolute on hover)
  - Summary line: "user-123 sent INCREMENT", "fetchPrice.onDone → success", "connect: user-456 (owner)"
  - Expandable detail: full payload/result + state diff
- State diff computed client-side: `jsonDiff(prevEntry.state, entry.state)`
- Visual diff view (added=green, removed=red, changed=yellow)
- Filter by cause type

**Connections panel**
- Table: caller ID, callerType, role, connected since, binary support
- Live updates on connect/disconnect

**Outbox panel**
- Table: service name, status badge, payload, attempts, created at
- Status: pending (yellow), running (blue), done (green), failed (red)

**Links panel**
- Two sections: "Linked to" (active_links) and "Subscribers" (link_subscribers)
- Each link shows: actor type, actor ID, link name, version

**Views panel**
- Dropdown to select role
- For perCaller views: additional caller ID input
- Shows computed view output as JSON tree
- Triggered on demand (sends `studio.requestView` over WebSocket)

## Migration / Rollout

### New SQLite migration

The `timeline` table is added as a new migration in `ACTOR_KIT_MIGRATIONS`. Existing actors pick it up on next `loadState()` → `runMigrations()`.

### Package dependency

`@actor-kit/studio` depends on `@actor-kit/worker` (for types) and bundles its own React UI.

The `@actor-kit/worker` package gains the timeline instrumentation and `__studio` WebSocket handling. The studio package provides the middleware, registry DO, and UI.

### No breaking changes

- Actors without the studio package: zero behavioral change, no timeline table created
- The `__studio` caller ID is reserved but doesn't affect existing role evaluation
- New RPC methods (`__inspect`, `__getTimeline`) are internal to the DO class

## Open items for implementation

- [ ] Exact JSON diff library choice for the UI (jsondiffpatch? fast-json-patch?)
- [ ] TanStack Start vs plain TanStack Router for the bundled SPA (Start may be overkill for a static SPA)
- [ ] Bundle strategy: how to embed the built SPA assets into the npm package
- [ ] Studio UI dark/light theme
- [ ] Whether to show binary-encoded view output alongside JSON in the views panel
- [ ] Rate limiting on `__inspect` / `__getTimeline` RPC in prod
