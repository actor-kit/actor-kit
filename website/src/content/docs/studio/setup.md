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

### 4. Set the secret (production only)

In production, studio routes require a secret key:

```bash
wrangler secret put ACTOR_KIT_STUDIO_SECRET
```

In local development (`wrangler dev`), no secret is needed — localhost is trusted.

## Authentication

| Environment | Auth |
|-------------|------|
| `localhost` / `127.0.0.1` | No auth required |
| Production | `X-Actor-Kit-Studio-Key` header must match `ACTOR_KIT_STUDIO_SECRET` |

For additional security in production, you can layer Cloudflare WAF rules or Cloudflare Access on top of the `/__studio/*` path.

## Enable timeline without StudioRegistry

If you want timeline recording without the registry (e.g., for testing), pass `studio: { enabled: true }` in your actor definition:

```typescript
const Counter = defineActor("counter", {
  // ... your actor definition
  studio: { enabled: true },
});
```

## Configuration

### Timeline size

Each actor stores the last 500 timeline entries by default. To change this:

```typescript
const Counter = defineActor("counter", {
  // ... your actor definition
  studio: {
    enabled: true,
    timelineSize: 1000, // keep more history
  },
});
```

## API routes

Once configured, the following routes are available:

| Route | Method | Description |
|-------|--------|-------------|
| `/__studio/` | GET | Studio UI |
| `/__studio/api/actors` | GET | List actors (query: `type`, `search`, `limit`, `offset`) |
| `/__studio/api/actors/types` | GET | List distinct actor types |
| `/__studio/api/actors/:type/:id` | GET | Inspect actor (state, connections, outbox, links) |
| `/__studio/api/actors/:type/:id/timeline` | GET | Timeline entries (query: `limit`, `before`) |
| `/__studio/actors/:type/:id/ws` | WS | Live studio WebSocket connection |

## RPC methods

Every actor DO exposes two RPC methods for programmatic access:

### `__inspect()`

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
