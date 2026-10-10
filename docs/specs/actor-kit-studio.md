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
| `STUDIO_ACCESS_TEAM_DOMAIN` | Prod | `<team>.cloudflareaccess.com` |
| `STUDIO_ACCESS_AUD` | Prod | AUD tag of the Studio Access application |
| `STUDIO_ADMIN_EMAILS` | Optional (secret) | Emails granted `mutate` |
| `STUDIO_CALLER_HASH_KEY` | For agents (secret) | HMAC key for agent caller hashing |

## Authentication

Superseded by [ADR-014](../adrs/014-studio-production-access.md): Cloudflare Access in front of `/__studio`, JWT verified in the middleware, read-only agents, server-side redaction (`studio.redact`) and one `studio.request` audit event per request. The shared `X-Actor-Kit-Studio-Key` header was removed.

### Local development (`wrangler dev`)

No auth required when no `STUDIO_ACCESS_*` setting is present and the URL hostname is exactly `localhost` or `127.0.0.1`.

### Production

Every `/__studio/*` request must carry a valid `Cf-Access-Jwt-Assertion` (Access adds it after SSO or a service token). The UI relies on the Access cookie; on 401/403 it offers "Sign in through Cloudflare Access".

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
- **On connect/disconnect**: update `connection_count`. The count is the number of app connections the DO holds (one per socket from `ctx.getWebSockets()`, minus Studio sockets), so it stays exact across hibernation, and is re-synced on every cold start (a restart drops sockets without `webSocketClose`).
- **On `spawn()` naming an auto-spawned actor**: re-key the registry row from the hex DO ID to the name (`touch(..., previousActorId)`), so it is listed once, under its name.
- Every row also records the actor's DO hex id (`do_id`), passed by the actor on `touch`/`updateConnections` and carried over on re-key, so `hasActor()` finds a named actor by its hex id too.

Registry inputs are Zod-parsed. Invalid fire-and-forget writes are dropped; invalid `listActors` options (negative, fractional or NaN `limit`/`offset`) throw. `search` matches `actor_id` as a case-insensitive (ASCII) substring with `%`/`_` taken literally. Results are ordered by `last_active_at DESC`, then type and ID.

If the registry is not in `ctx.exports`, no registration occurs. Zero overhead for users who haven't set up the studio.

### Registry RPC API

```typescript
class StudioRegistry extends DurableObject {
  // Called by actors (fire-and-forget)
  // previousActorId re-keys a row (hex DO ID → spawn() name), keeping its connection count and do_id
  // doId is the actor's DO hex id (ctx.id.toString())
  touch(actorType: string, actorId: string, version: number, previousActorId?: string, doId?: string): void;
  // Upserts: a connect is real activity, so an unregistered actor is registered here
  updateConnections(actorType: string, actorId: string, count: number, doId?: string): void;

  // Called by studio middleware: exact match on actor_id OR do_id
  hasActor(actorType: string, actorId: string): Promise<boolean>;

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

### Timeline = the journal (ADR-017 §5)

Studio's timeline is read from the actor journal (`events` + `journal_checkpoints`, ADR-013). The
old `timeline` table is dropped by migration `0015_drop_timeline`. An entry is one journal event:

| Field | Source |
|---|---|
| `id`, `seq` | the event's journal seq (also the pagination cursor) |
| `causeType`, `causeData` | the event's cause, mapped to the `MutationCause` shape above (`runtime/journal-timeline.ts`) |
| `stateSnapshot` | the persisted after-state: the checkpoint at that seq, or the fold from the newest checkpoint before it (or from init) through the step core, checksum-verified; `null` when it cannot be rebuilt |
| `checksum`, `createdAt` | the event's `state_checksum` and `created_at` |

### Retention

Journal retention (`journal: { keep }`) is the only retention; by default the journal keeps every
event. `journal: false` means no timeline.

### State diffs

Diffs are **not computed or stored in the DO**. Each entry carries its full "after" state, rebuilt from the journal when the timeline is read. The studio UI computes `jsonDiff(entry[n-1].state, entry[n].state)` client-side, only when both states are known.

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

### Connections and timeline identity

- Every app socket gets a `connectionId` (UUID) and `connectedAt` in its WebSocket attachment (`serializeAttachment`). `ConnectionInfo` is `{ connectionId, caller, callerType, connectedAt, role }`, read from the sockets the DO holds, so two tabs of one caller are two connections, hibernation keeps them, and a restart clears them. `studio.connection` disconnect events carry the `connectionId`. Because lifecycle hooks also fire per socket, the lifecycle event carries `callerConnections` (that caller's open sockets after the event) so per-user state such as presence only changes on a caller's first connect and last disconnect.
- Live `studio.timeline` entries carry the row `id`, the same id `__getTimeline()` and the snapshot use. A Studio that reconnects replaces its timeline with the snapshot and merges live entries by `id`, so nothing is duplicated.
- The Studio UI reconnects its WebSocket with backoff (restart, network drop, or an actor that does not exist yet) and takes the fresh snapshot as the truth.

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

// Pushed when an execution is added (pending) or settles (done / failed).
// Carries the whole outbox, newest first; the UI replaces its list.
type StudioOutboxChange = {
  type: "studio.outbox";
  outbox: OutboxEntry[];
};

// Pushed when active_links or link_subscribers change: link, unlink, a
// subscriber registering or leaving, and a link version bump on delivery.
// Carries both lists in full; the UI replaces them.
type StudioLinksChange = {
  type: "studio.links";
  activeLinks: ActiveLink[];        // { targetType, targetId, linkName, version }
  linkSubscribers: LinkSubscriber[]; // { subscriberType, subscriberId }
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

Request handling rules:

- Only `/__studio` and `/__studio/*` are intercepted; `/__studiofoo` and similar pass through to the app.
- Auth runs first. Then any method other than `GET`/`HEAD` is `405` (`Allow: GET, HEAD`).
- Path segments and query params are parsed before anything is contacted: malformed percent-encoding, `limit` outside 1–1000, negative/non-integer `limit`/`offset`/`before`, empty `type`, or `search` over 256 chars are `400`.
- An actor DO is only contacted once `StudioRegistry.hasActor(type, id)` confirms it exists (checked under the spawn name and its DO hex id), so looking up an unknown actor is `404` and never auto-spawns a phantom actor. Without a registry binding the check is skipped.
- Unknown routes under `/__studio/api/` are a JSON `404`; every other unknown path serves the SPA shell (client-side routes, including actor ids containing dots); unknown `/__studio/assets/*` is `404`.
- Every error body is JSON: `{ "error": string }` (message only, no stack).

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
- The UI keeps at most 500 timeline entries in memory. Large arrays/objects render 100 children at a time; strings over 200 characters and diffs over 200 rows are truncated with a control to show more.

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
- A subscriber is listed by its actor ID (the name the target resolves with `idFromName()`), not its hex Durable Object ID
- Both panels update live from `studio.outbox` / `studio.links`

**Views panel**
- Dropdown to select role
- For perCaller views: additional caller ID input
- Shows computed view output as JSON tree
- Triggered on demand (sends `studio.requestView` over WebSocket)

## Migration / Rollout

### New SQLite migration

The `timeline` table was added by migration `0006_timeline` and is dropped by `0015_drop_timeline` (ADR-017): the timeline is read from the journal.

### Package dependency

`@actor-kit/studio` depends on `@actor-kit/worker` (for types) and bundles its own React UI.

The `@actor-kit/worker` package gains the timeline instrumentation and `__studio` WebSocket handling. The studio package provides the middleware, registry DO, and UI.

### No breaking changes

- Actors without the studio package: zero behavioral change (the journal is written either way)
- The `__studio` caller ID is reserved but doesn't affect existing role evaluation
- New RPC methods (`__inspect`, `__getTimeline`) are internal to the DO class

## Actor-side behaviour (as implemented)

Pinned by `tests/integration/studio-instrumentation.test.ts` and `tests/unit/studio-protocol.test.ts`.

- **Opt-out**: `studio: { enabled: false }` disables instrumentation even when a registry is bound: no timeline, no registry registration. `__inspect` / `__getTimeline` throw `Studio is not enabled for this actor`; the studio WebSocket gets `404`.
- **Retention** is the journal's: `journal.keep` (a positive integer, validated at definition time) prunes events, and the timeline shows what is left. There is no `timelineSize`.
- **Migration**: loading a snapshot whose version differs from `version` (with `migrate` defined) persists the migrated state immediately and records a `migrate` timeline entry `{ fromVersion, toVersion }`.
- **Live pushes**: `studio.timeline.entry` is built from the event just journaled and has the same shape as `__getTimeline` entries, including `id` (= seq). Nothing is pushed with `journal: false`.
- **`__getTimeline(opts)`**: `limit` (positive integer, default 50) and `before` (positive integer, exclusive seq cursor) are validated; anything else throws `Invalid timeline options: …`. Because the cursor is the unique `id`, equal timestamps never cause duplicates or gaps.
- **Read-only lookups**: `__inspect` / `__getTimeline` never auto-spawn, persist or register an actor. For an ID that was never persisted, `__inspect` returns `{ initialized: false, state: null, actorId: null, connections: [], outbox: [], activeLinks: [], linkSubscribers: [] }` and `__getTimeline` returns `{ entries: [], hasMore: false }`. `__inspect` always includes `initialized`.
- **Reserved caller**: `__studio` is honoured only with `callerType: "service"`; a `user` caller with that ID gets `403`.
- **Connections list** is per socket: two tabs of one caller are two connections, each with its own `connectionId`, its own `studio.connection` `connect`, and its own `disconnect` when that tab closes. The registry `connection_count` counts the same app sockets (from `ctx.getWebSockets()`, so it is correct after hibernation) and excludes studio sockets.
- **Registry**: an app client connecting counts as activity and touches the registry (debounced), so an actor persisted before the registry knew it still appears. Studio sockets never touch the registry.
- **Studio → DO frames**: `studio.requestView` takes `{ role, caller?, callerType? }`. Replies are `studio.view` with `{ role, caller, callerRole, data }` (`callerRole` is the caller's actual role, or `null` — the view is still computed so the UI can preview it), or `studio.view` with `{ role, caller, error }` for an unknown role (own properties only), a perCaller view without `caller`, or a throwing projection. Invalid JSON, malformed requests and any other frame type (app messages included) get `{ type: "studio.error", error }`.

## Open items for implementation

- [ ] Exact JSON diff library choice for the UI (jsondiffpatch? fast-json-patch?)
- [ ] TanStack Start vs plain TanStack Router for the bundled SPA (Start may be overkill for a static SPA)
- [ ] Bundle strategy: how to embed the built SPA assets into the npm package
- [ ] Studio UI dark/light theme
- [ ] Whether to show binary-encoded view output alongside JSON in the views panel
- [ ] Rate limiting on `__inspect` / `__getTimeline` RPC in prod
