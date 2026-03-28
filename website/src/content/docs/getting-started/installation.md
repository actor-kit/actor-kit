---
title: Installation
description: Install Actor Kit and set up your project.
---

## Install

```bash
pnpm add actor-kit zod
```

Actor Kit is a single package with subpath exports:

| Import | Usage |
|--------|-------|
| `actor-kit` | Core: `defineActor`, `createActorClass`, `message`, `view`, `schema`, `createRef`, `createAccessToken` |
| `actor-kit/client` | Browser: `actorClient` — WebSocket connection with binary decoding |
| `actor-kit/react` | React: `actorContext` — hooks for view, send, role |
| `actor-kit/test` | Testing: `testActor` — pure transitions without CF runtime |

Actor Kit uses [Zod](https://zod.dev) for message payload validation at runtime boundaries.

## Prerequisites

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) account
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI (`pnpm add -D wrangler`)
- Node.js 20+
- pnpm (recommended)

## Project Setup

### 1. Create a Worker project

```bash
pnpm create cloudflare@latest my-actor-app
cd my-actor-app
pnpm add actor-kit zod
```

### 2. Configure wrangler.toml

```toml
name = "my-actor-app"
main = "src/worker.ts"
compatibility_date = "2024-09-25"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "MY_ACTOR"
class_name = "MyActor"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MyActor"]
```

Key points:
- `nodejs_compat` is required for the `jose` JWT library
- `new_sqlite_classes` enables DO SQLite storage for your actor

### 3. Set up secrets

**Never put secrets in `wrangler.toml`** — they get committed to git.

For local development, create a `.dev.vars` file (gitignored):

```
ACTOR_KIT_SECRET = "dev-secret-do-not-use-in-production"
```

For production, use `wrangler secret`:

```bash
npx wrangler secret put ACTOR_KIT_SECRET
```

### 4. Define your actor

See the [Quick Start](/getting-started/quick-start/) for a complete example.

## TypeScript

Actor Kit is written in TypeScript with strict mode. Types are inferred from your actor definition — no manual type annotations needed. `defineActor()` returns a typed contract that preserves all generic information for downstream consumers.

For editor support in Worker files, install the types:

```bash
pnpm add -D @cloudflare/workers-types
```

## Testing

For unit tests with `testActor()`:

```bash
pnpm add -D vitest
```

For integration tests with real Durable Objects:

```bash
pnpm add -D @cloudflare/vitest-pool-workers
```

For E2E tests:

```bash
pnpm add -D @playwright/test
npx playwright install chromium
```
