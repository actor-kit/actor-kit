# ADR 008: Typed Request Callbacks and On Block Restructuring

**Date**: 2026-03-24
**Status**: Proposed

## Context

The current `request()` API uses plain strings for callback names:

```typescript
ctx.request({
  fetch: url,
  onDone: "PRICE_RECEIVED",   // string — no type link
  onError: "PRICE_FAILED",    // string — no type link
});

on: {
  PRICE_RECEIVED: (state, result) => ...,  // result is unknown
}
```

This has three problems:

1. **No compile-time link between `request()` and `on` handlers.** Typo in the callback name? Runtime error, not a compile error. Handler expects `{ price: number }` but receives `{ total: number }`? Silent bug.

2. **No way to pass per-request context.** If you fetch prices for multiple items concurrently, the callback doesn't know which item the response is for. The workaround — stash context in state — breaks with concurrent requests (second overwrites first).

3. **The `on` block conflates lifecycle events and request callbacks.** `connect`/`disconnect` (framework-initiated, no payload) sit alongside `PRICE_RECEIVED` (effect-initiated, typed payload). They have different trust boundaries and different handler signatures, but the type system treats them identically as `(state: unknown, ...args: unknown[]) => unknown`.

A type safety audit (see ADR-001) found this is the biggest user-facing type gap in the framework. Codex cross-review confirmed: "typed at the leaf, erased at the trunk."

## Decision

### 1. Typed callback definitions via `callback()`

Introduce a `callback()` helper (analogous to `message()`) that pairs a name with a Zod payload schema:

```typescript
import { callback } from "@actor-kit/worker";

const PriceReceived = callback(
  "PRICE_RECEIVED",
  z.object({ total: z.number() }),
);

const PriceFailed = callback(
  "PRICE_FAILED",
  z.object({ message: z.string() }),
);
```

`request()` takes callback defs, not strings:

```typescript
ctx.request({
  fetch: `https://api.example.com/prices/${itemId}`,
  onDone: PriceReceived,
  onError: PriceFailed,
});
```

The compiler enforces that `PriceReceived` is declared and that the `on.callbacks` handler matches its payload schema.

### 2. Typed `meta` for per-request context

`request()` accepts a typed `meta` field that passes through to the callback handler:

```typescript
const PriceReceived = callback(
  "PRICE_RECEIVED",
  z.object({ total: z.number() }),
  z.object({ itemId: z.string(), requestedBy: z.string() }),  // meta schema
);

ctx.request({
  fetch: url,
  onDone: PriceReceived,
  onError: PriceFailed,
  meta: { itemId, requestedBy: caller },  // type-checked against meta schema
});
```

The callback handler receives both `result` and `meta`:

```typescript
callbacks: {
  PRICE_RECEIVED: (state, { result, meta }, ctx) => {
    // result: { total: number }  — from the fetch response, validated by Zod
    // meta: { itemId: string, requestedBy: string }  — from the request site
    return { ...state, prices: { ...state.prices, [meta.itemId]: result.total } };
  },
}
```

Meta is persisted in the outbox alongside the effect, so it survives DO restarts.

### 3. Split `on` into `lifecycle` + `callbacks`

Replace the current flat `on` block:

```typescript
// Before (flat, untyped)
on: {
  connect: (state, caller) => ...,
  disconnect: (state, caller) => ...,
  PRICE_RECEIVED: (state, result) => ...,
}
```

With two typed blocks:

```typescript
// After (split, typed)
lifecycle: {
  connect: (state, { caller, callerType }, ctx) => ...,
  disconnect: (state, { caller, callerType }, ctx) => ...,
},

callbacks: {
  PRICE_RECEIVED: (state, { result, meta }, ctx) => ...,
  PRICE_FAILED: (state, { error, meta }, ctx) => ...,
},
```

`lifecycle` handlers have a fixed signature — `{ caller, callerType }` event + full ctx (emit, request, env).

`callbacks` handlers are typed per callback def — the payload shape is inferred from the `callback()` definition. They also receive full ctx.

### Type flow

```
callback("PRICE_RECEIVED", resultSchema, metaSchema)
                    ↓
        request({ onDone: PriceReceived, meta: { itemId } })
                    ↓  compile-time: meta matches metaSchema
                    ↓  runtime: meta persisted in outbox
                    ↓
        callbacks.PRICE_RECEIVED(state, { result, meta }, ctx)
                    ↓  compile-time: result matches resultSchema, meta matches metaSchema
                    ↓  runtime: result parsed by Zod before handler
```

## Consequences

### Positive

- Compile-time link between `request()` call site and callback handler — typos caught by the compiler
- Typed `result` and `meta` in callback handlers — no `unknown`, no casts
- Per-request context (`meta`) enables concurrent requests without state-level bookkeeping
- `lifecycle` handlers get a consistent `{ caller, callerType }` event shape + ctx with emit/request
- `callback()` follows the same pattern as `message()` — Zod schema + handler. Consistent API surface.
- `meta` is persisted in outbox — survives DO crash/restart

### Negative

- Breaking change to `on` block — all existing actors need to migrate to `lifecycle` + `callbacks`
- `callback()` is a new concept to learn alongside `message()` and `view()`
- Request callback defs must be declared at the module level (like message defs), not inline

### Neutral

- The `callback()` helper is structurally similar to `message()` — same Zod + handler pattern, familiar API
- Callbacks are still fire-and-forget from the actor's perspective — the framework delivers them, the actor doesn't await them
- `emit()` is unchanged — fire-and-forget effects don't need callbacks
