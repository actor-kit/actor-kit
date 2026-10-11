---
title: Studio Setup
description: How to add Actor Kit Studio to your project.
---

## Install

```bash
pnpm add @actor-kit/studio
```

## Configure your Worker

### 1. Export the StudioRegistry

Add the `StudioRegistry` Durable Object to your Worker's exports:

```typescript
import { actorKitStudio, StudioRegistry } from "@actor-kit/studio";

// Export the registry DO class
export { StudioRegistry };
```

### 2. Add the middleware

Insert `actorKitStudio()` at the top of your Worker's `fetch` handler. It intercepts `/__studio/*` routes and passes everything else through:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Studio middleware — handles /__studio/* routes
    const studio = actorKitStudio(request, env, ctx);
    if (studio) return studio;

    // ... your normal routing below
  },
};
```

### 3. Add the DO binding

In your `wrangler.toml`, add a binding for the `StudioRegistry`:

```toml
[[durable_objects.bindings]]
name = "STUDIO_REGISTRY"
class_name = "StudioRegistry"

[[migrations]]
tag = "v2"  # increment your migration tag
new_sqlite_classes = ["StudioRegistry"]
```

### 4. Production: put `/__studio` behind Cloudflare Access

In local development (`wrangler dev` on `localhost` / `127.0.0.1`) with no Access settings, Studio is open. In production, Studio requires [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/): people sign in with SSO, and each agent gets its own service token. The middleware verifies the `Cf-Access-Jwt-Assertion` JWT itself (RS256, issuer, audience, expiry), so a route Access doesn't cover (e.g. `*.workers.dev`) is still refused. See ADR-014.

Set these on the Worker:

| Setting | How | Purpose |
|---|---|---|
| `STUDIO_ACCESS_TEAM_DOMAIN` | var | `<team>.cloudflareaccess.com` |
| `STUDIO_ACCESS_AUD` | var | AUD tag of the Studio Access application |
| `STUDIO_ADMIN_EMAILS` | `wrangler secret put` | comma-separated emails allowed to **mutate** (e.g. future journal restore) |
| `STUDIO_CALLER_HASH_KEY` | `wrangler secret put` | HMAC key that hashes callers for agents |

```bash
openssl rand -hex 32 | wrangler secret put STUDIO_CALLER_HASH_KEY
wrangler secret put STUDIO_ADMIN_EMAILS
```

## Authentication and permissions

| Who | How | Can |
|---|---|---|
| Localhost, no Access settings | nothing | read + mutate (dev) |
| Person | Access SSO cookie (browser) or `cloudflared access token` (CLI) | read; mutate if in `STUDIO_ADMIN_EMAILS` |
| Agent | Access service token (`CF-Access-Client-Id` / `-Secret`) | read only, never mutate; callers are hashed |
| Anything else | | 401 (no or invalid token) / 403 (Studio not configured) |

Every Studio request logs one `studio.request` JSON line (principal, subject, route, actor, status, duration), never bodies or tokens.

## Redaction

Values an actor declares in `studio.redact` are replaced with `"[redacted]"` **inside the Durable Object**, before anything is returned to Studio, for everyone, people included:

```typescript
const Game = game.actor("game", {
  // ...
  studio: { redact: ["players.*.name", "**.email"] },
});
```

`*` matches one key or array index, `**` any depth. The same patterns apply to state, timeline snapshots, message payloads, service input/output, link views, outbox payloads and role views, each relative to its own root. Object **keys** are not redacted, so key records by id, not by a person's name.

## CLI and MCP (`@actor-kit/studio-cli`)

```bash
export ACTOR_KIT_STUDIO_URL=https://game.example.com
export CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...   # agent service token
# or, for a person: export CF_ACCESS_TOKEN=$(cloudflared access token -app=$ACTOR_KIT_STUDIO_URL/__studio)
actor-kit studio list --type game
actor-kit studio inspect game room-7
actor-kit studio timeline game room-7 --limit 20 --shape   # no values: safe for a public issue
actor-kit studio journal game room-7 --event RoundWon --order asc   # entries that emitted RoundWon, oldest first
actor-kit studio journal game room-7 --correlation-id game/room-7/12   # one flow: a message and everything it caused
actor-kit studio view game room-7 --role player --caller <id>
```

`actor-kit-studio-mcp` serves the same tools over stdio: `studio_list_actors`, `studio_actor_types`, `studio_inspect`, `studio_timeline` and `studio_journal` (shape by default) and `studio_view`.

The journal query (`GET /__studio/api/actors/:type/:id/journal`, the `__journal()` RPC) filters journal
entries by seq range (`from`, `to`, `before`), `causeType`, emitted `event` name and `correlationId`,
newest first or `order=asc`. Each entry has its cause, the domain events it emitted (marked `published`
when `publish` sends them) and its correlation and causation ids, redacted like everything else.

## Enable timeline without StudioRegistry

If you want timeline recording without the registry (e.g., for testing), pass `studio: { enabled: true }` in your actor definition:

```typescript
const Counter = counter.actor("counter", {
  // ... your actor definition
  studio: { enabled: true },
});
```

## Configuration

### Timeline history

The timeline is the actor's journal: every journaled event is a timeline entry, and the state
after it is read from a journal checkpoint or replayed from the newest one before it. There is no
separate timeline table or size. The journal keeps everything by default; to bound it (and so the
timeline), set `journal.keep`:

```typescript
const Counter = counter.actor("counter", {
  // ... your actor definition
  journal: { keep: 10_000 }, // roughly the newest 10,000 events
});
```

An actor with `journal: false` has an empty timeline. An entry whose state cannot be rebuilt
(written by an older code version, or before the oldest checkpoint left after pruning) shows
"State not available" instead of a state.

## API routes

Once configured, the following routes are available:

| Route | Method | Description |
|-------|--------|-------------|
| `/__studio/` | GET | Studio UI |
| `/__studio/api/actors` | GET | List actors (query: `type`, `search`, `limit`, `offset`) |
| `/__studio/api/actors/types` | GET | List distinct actor types |
| `/__studio/api/actors/:type/:id` | GET | Inspect actor (state, connections, outbox, links) |
| `/__studio/api/actors/:type/:id/timeline` | GET | Timeline entries (query: `limit`, `before`) |
| `/__studio/api/actors/:type/:id/view` | GET | A role's view (query: `role`, `caller`) |
| `/__studio/actors/:type/:id/ws` | WS | Live studio WebSocket connection |

## RPC methods

Every actor DO exposes three RPC methods for programmatic access. All are redacted; pass `{ viewer: "agent" }` to also hash callers.

### `__inspect(opts?)`

Returns current state, metadata, connections, outbox, and links.

```typescript
const stub = env.COUNTER.get(env.COUNTER.idFromName("my-counter"));
const info = await stub.__inspect();
// { state, version, actorId, connections, outbox, activeLinks, linkSubscribers }
```

### `__getTimeline(opts?)`

Returns paginated timeline entries (newest first).

```typescript
const result = await stub.__getTimeline({ limit: 20 });
// { entries: [...], hasMore: boolean }

// Paginate with cursor:
const page2 = await stub.__getTimeline({ limit: 20, before: lastEntryId });
```

### `__getView(opts)`

```typescript
const reply = await stub.__getView({ role: "player", caller: "user-1" });
// { type: "studio.view", role, caller, callerRole, data } or { ..., error }
```
