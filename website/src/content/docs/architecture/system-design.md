---
title: System Design
description: Deep dive into Actor Kit's architecture, module boundaries, and type system.
---

Actor Kit is organized into 7 packages with strict dependency boundaries. This page covers the system architecture in detail.

## Module boundaries

| Module | Entry point | Responsibility | Dependencies |
|--------|-------------|----------------|-------------|
| Types & schemas | `@actor-kit/types` | Type definitions, Zod schemas, shared constants | zod, xstate (types only) |
| Machine server | `@actor-kit/worker` | DO class factory, XState lifecycle, persistence, WebSocket management | xstate, fast-json-patch, xstate-migrate, jose |
| Router | `@actor-kit/worker` | HTTP/WebSocket request routing, JWT validation, DO spawning | jose, zod |
| Browser client | `@actor-kit/browser` | WebSocket connection, reconnection, state patching, event queuing | fast-json-patch, immer |
| React bindings | `@actor-kit/react` | Context, Provider, hooks (useSelector, useSend, useMatches) | react |
| Server utilities | `@actor-kit/server` | JWT creation, HTTP state fetching | jose |
| Test utilities | `@actor-kit/test` | Mock client with Immer-based state control | immer |
| Storybook | `@actor-kit/storybook` | withActorKit decorator, parameter-based snapshots | react |

## Dependency graph

```
@actor-kit/types
  ├── @actor-kit/browser → @actor-kit/react
  ├── @actor-kit/worker  → @actor-kit/server
  ├── @actor-kit/test    → @actor-kit/browser
  └── @actor-kit/storybook → @actor-kit/react + @actor-kit/test
```

`@actor-kit/types` is the root — every package depends on it. The browser/react path and the worker/server path are independent, so server code never ships to the browser bundle.

## Type system

The type system enforces that events, context, and snapshots are aligned at compile time:

```
ActorKitStateMachine<TEvent, TInput, TContext>
  │
  ├─ TEvent = ClientEvent | ServiceEvent | SystemEvent
  │   augmented with: caller, storage, env, requestInfo
  │
  ├─ TInput = WithActorKitInput<TInputProps>
  │   augmented with: id, caller (initial creator)
  │
  └─ TContext = { public: {...}, private: Record<string, {...}> }
      │
      └─ CallerSnapshotFrom<TMachine>
          = { public, private[callerId], value }
          (what each client actually sees)
```

Key derived types:
- `ClientEventFrom<TMachine>` — events the browser can send
- `ServiceEventFrom<TMachine>` — events backend services can send
- `CallerSnapshotFrom<TMachine>` — snapshot shape for a specific caller
- `EnvFromMachine<TMachine>` — Cloudflare env bindings

## Authentication flow

JWT-based, stateless authentication:

| JWT Claim | Maps to | Purpose |
|-----------|---------|---------|
| `jti` | Actor ID | Ties token to specific actor instance |
| `aud` | Actor type | Prevents cross-type token reuse |
| `sub` | `{callerType}-{callerId}` | Identifies the caller |
| `exp` | 30 days | Token lifetime |

Signing uses HS256 with `ACTOR_KIT_SECRET` from the Worker environment.

## Persistence model

When `persisted: true`:

1. **On spawn**: Actor metadata stored (`actorType`, `actorId`, `initialCaller`, `input`)
2. **On each transition**: Full snapshot persisted to `PERSISTED_SNAPSHOT_KEY`
3. **On resume** (DO restart): Snapshot restored, `xstate-migrate` applies schema migrations, `RESUME` system event sent
4. **Snapshot format**: `{ value, context: { public, private }, version? }`

## Sync protocol

See [Sync Protocol](/concepts/sync-protocol/) for the full description of checksum-based deduplication, JSON Patch diffs, and caller-scoped snapshot delivery.
