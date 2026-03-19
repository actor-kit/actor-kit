# Replace @cloudflare/workers-types with Minimal Ambient Declarations

**Date:** 2026-03-18
**Status:** Accepted

## Context

actor-kit uses `@cloudflare/workers-types` as both a peer dependency and dev dependency to provide TypeScript types for Cloudflare Workers runtime APIs (DurableObject, DurableObjectState, DurableObjectStorage, DurableObjectNamespace, WebSocket.accept(), Response.webSocket, etc.).

Three problems forced a change:

1. **Deprecated**: Cloudflare deprecated `@cloudflare/workers-types` in favor of `wrangler types`, which generates runtime types from the actual workerd binary.
2. **Resolution failures**: The package doesn't resolve properly in pnpm, causing build issues.
3. **DOM conflicts**: The library's tsconfig includes `"lib": ["dom"]` for React entry points, but `@cloudflare/workers-types` overrides globals like `WebSocket` and `Response` with Workers-specific versions, creating type conflicts.

The library has a split audience: `@actor-kit/react` and `@actor-kit/browser` consumers use DOM types, while `@actor-kit/worker` consumers run in the Workers runtime. A single global type overlay doesn't serve both.

## Decision

Replace `@cloudflare/workers-types` with two strategies:

### For the library (`src/`)
Create a minimal ambient type declaration file (`src/cloudflare-ambient.d.ts`) that declares only the CF Workers types the library actually uses. This avoids global DOM conflicts while providing the specific interfaces needed:
- `DurableObjectStorage`, `DurableObjectState`, `DurableObjectNamespace`, `DurableObjectId`
- Workers-specific `WebSocket.accept()` method
- Workers-specific `Response.webSocket` property
- `WebSocketPair`

### For tests (`tests/workers/`)
Use `wrangler types` to generate `worker-configuration.d.ts` with full runtime types, including typed `DurableObjectNamespace<Counter>` and `DurableObjectNamespace<Aggregator>` bindings. This replaces both `@cloudflare/workers-types` and the hand-written `Env` interface.

### Eliminate `as` casts
With proper types available, eliminate platform-boundary `as` casts:
- `(response as unknown as { webSocket?: WebSocket }).webSocket` → direct property access
- `event.data as ArrayBuffer | Uint8Array` → proper Workers `MessageEvent` typing
- `JSON.parse(raw) as ActorKitEmittedEvent` → Zod runtime validation
- `namespace.getByName(name) as ActorServerMethods<TMachine>` → properly typed namespace

XState framework-required `{} as T` in `setup({ types })` blocks are preserved — these are structural requirements of XState's type inference, not safety violations.

## Consequences

### Positive
- No more deprecated dependency
- No DOM/Workers type conflicts
- Library consumers no longer need `@cloudflare/workers-types` as a peer dependency
- Test types are generated from the actual runtime, always accurate
- `as` casts at platform boundaries are eliminated, improving type safety

### Negative
- The ambient declarations in `src/cloudflare-ambient.d.ts` must be maintained manually if the library starts using new CF APIs
- `wrangler types` must be re-run when test worker bindings change

### Neutral
- The `cloudflare` npm package (API client) remains as a dependency — it's unrelated to runtime types
