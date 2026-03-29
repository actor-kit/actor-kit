---
title: Installation
description: Install Actor Kit and set up your project.
---

## Install

Server (Cloudflare Worker):

```bash
pnpm add @actor-kit/core @actor-kit/worker zod
```

Client (browser):

```bash
pnpm add @actor-kit/core @actor-kit/client
```

| Package | Usage |
|---------|-------|
| `@actor-kit/core` | Shared: `schema`, `view`, type primitives (`uint32`, `string`, etc.), `encode`, `decode` |
| `@actor-kit/worker` | Server: `defineActor`, `createActorClass`, `message`, `withCallerIdentity` |
| `@actor-kit/worker/token` | Opt-in: `createAccessToken`, `getCallerFromToken` (JWT auth for external clients) |
| `@actor-kit/client` | Browser: `actorClient` — WebSocket connection with binary decoding |
| `@actor-kit/react` | React: `actorContext` — hooks for view, send, role |
| `@actor-kit/test` | Testing: `testActor` — pure transitions without CF runtime |

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
pnpm add @actor-kit/core @actor-kit/worker zod
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
- `nodejs_compat` is required for crypto APIs used by the binary encoder
- `new_sqlite_classes` enables DO SQLite storage for your actor

### 3. Define your actor

See the [Quick Start](/getting-started/quick-start/) for a complete example.

## TypeScript

Actor Kit is written in TypeScript with strict mode. Types are inferred from your actor definition — no manual type annotations needed. `defineActor()` returns a typed contract that preserves all generic information for downstream consumers.

For editor support in Worker files, install the types:

```bash
pnpm add -D @cloudflare/workers-types
```

## Testing

`@actor-kit/test` provides `testActor()` — a typed test harness that runs your actor without a Cloudflare runtime:

```bash
pnpm add -D @actor-kit/test vitest
```

```typescript
import { testActor } from "@actor-kit/test";
import { Counter } from "./counter";

const t = testActor(Counter);
const state = t.init({});
const next = await t.send(state, "alice", { type: "INCREMENT" });
// next.count === 1 — fully typed from the contract
```

`testActor()` covers role evaluation, message routing, Zod validation, guards, view projection, and emission capture. See [Testing](/concepts/testing/) for the full guide.
