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
| `@actor-kit/client` | Browser: `actorClient` — WebSocket connection with binary decoding |
| `@actor-kit/react` | React: `actorContext` — hooks for view, send, role |
| `@actor-kit/test` | Testing: `testActor` — fast unit tests without Wrangler |

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
compatibility_flags = ["enable_ctx_exports"]

[[durable_objects.bindings]]
name = "MY_ACTOR"
class_name = "MyActor"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MyActor"]
```

Key points:
- `enable_ctx_exports` enables automatic actor discovery via `ctx.exports` (recommended for single-Worker deployments)
- `new_sqlite_classes` enables DO SQLite storage for your actor

### 3. Define your actor

See the [Quick Start](/getting-started/quick-start/) for a complete example.

## TypeScript

Actor Kit is written in TypeScript with strict mode. Types are inferred from your actor definition — no manual type annotations needed. `defineActor()` returns a typed contract that preserves all generic information for downstream consumers.

Wrangler generates Worker types for you — no manual type package needed:

```bash
pnpm wrangler types
```

This creates a `worker-configuration.d.ts` file with types for your bindings and the CF runtime. Re-run it whenever you change `wrangler.toml`.

## Testing

`@actor-kit/test` provides `testActor()` — a typed test harness that runs your actor without a Cloudflare runtime:

```bash
pnpm add -D @actor-kit/test vitest
```

```typescript
import { testActor } from "@actor-kit/test";
import { CounterContract } from "./counter.contract";

const t = testActor(CounterContract);
const state = t.init({});
const next = await t.send(state, "alice", { type: "INCREMENT" });
// next.count === 1 — fully typed from the contract
```

`testActor()` covers role evaluation, message routing, Zod validation, guards, view projection, and emission capture. See [Testing](/concepts/testing/) for the full guide.
