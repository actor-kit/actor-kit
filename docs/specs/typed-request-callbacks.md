# Spec: Typed Request Callbacks

**ADR**: [008-typed-request-callbacks](../adrs/008-typed-request-callbacks.md)
**Priority**: P0 — blocks offensive typesafety claim

## Overview

Replace string-based `onDone`/`onError` with typed `callback()` defs. Split `on` into `lifecycle` + `callbacks`. Add typed `meta` for per-request context.

## API Surface

### `callback(name, resultSchema)` — no meta

```typescript
import { callback } from "@actor-kit/worker";

const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));
const PriceFailed = callback("PRICE_FAILED", z.object({ message: z.string() }));
```

### `callback(name, resultSchema, metaSchema)` — with meta

```typescript
const PriceReceived = callback(
  "PRICE_RECEIVED",
  z.object({ total: z.number() }),
  z.object({ itemId: z.string() }),
);
```

### `request()` — takes callback defs

```typescript
ctx.request({
  fetch: url,
  onDone: PriceReceived,
  onError: PriceFailed,
  meta: { itemId: "widget-1" },  // type-checked against PriceReceived's meta schema
});
```

### Actor definition — `lifecycle` + `callbacks`

```typescript
export const PriceChecker = actor<Env>("price-checker", {
  input: z.object({}),
  init: () => ({ prices: {} as Record<string, number>, errors: [] as string[] }),

  roles: { user: () => true },

  messages: {
    user: { FETCH_PRICE: fetchPrice },
  },

  lifecycle: {
    connect: (state, { caller }, ctx) => state,
    disconnect: (state, { caller }, ctx) => state,
  },

  callbacks: {
    PRICE_RECEIVED: (state, { result, meta }, ctx) => ({
      ...state,
      prices: { ...state.prices, [meta.itemId]: result.total },
    }),
    PRICE_FAILED: (state, { error, meta }, ctx) => ({
      ...state,
      errors: [...state.errors, `${meta.itemId}: ${error.message}`],
    }),
  },

  views: {
    user: view(PriceView, (state) => ({ prices: state.prices })),
  },
});
```

## Type Signatures

### `CallbackDef<TKey, TResult, TMeta>`

```typescript
interface CallbackDef<
  TKey extends string,
  TResult,
  TMeta = void,
> {
  readonly key: TKey;
  readonly resultSchema: z.ZodType<TResult>;
  readonly metaSchema?: z.ZodType<TMeta>;
}
```

### `callback()` overloads

```typescript
// Without meta
function callback<TKey extends string, TResult>(
  key: TKey,
  resultSchema: z.ZodType<TResult>,
): CallbackDef<TKey, TResult, void>;

// With meta
function callback<TKey extends string, TResult, TMeta>(
  key: TKey,
  resultSchema: z.ZodType<TResult>,
  metaSchema: z.ZodType<TMeta>,
): CallbackDef<TKey, TResult, TMeta>;
```

### `RequestConfig` — generic over callback defs

```typescript
type RequestConfig<
  TDone extends CallbackDef<string, unknown, unknown>,
  TFail extends CallbackDef<string, unknown, unknown>,
> = Effect & {
  onDone: TDone;
  onError: TFail;
  meta: TDone extends CallbackDef<string, unknown, infer M> ? M extends void ? never : M : never;
};
```

### Callback handler signature

```typescript
type CallbackHandler<TState, TResult, TMeta, TEnv> = (
  state: TState,
  payload: TMeta extends void ? { result: TResult } : { result: TResult; meta: TMeta },
  ctx: { caller: string; callerType: "user" | "service"; env: TEnv; emit: EmitFn; request: RequestFn },
) => TState | Promise<TState>;
```

## Implementation Plan

### Phase 1: `callback()` helper + `CallbackDef` type
- New file: `packages/actor-kit/src/core/callback.ts`
- Export from `packages/actor-kit/src/core/index.ts`
- Tests: `tests/unit/callback.test.ts` — type inference, Zod validation

### Phase 2: Update `RequestConfig` to accept callback defs
- Modify: `packages/actor-kit/src/core/message.ts`
- `request()` on `MessageContext` becomes generic
- Outbox stores meta alongside the effect
- Tests: `tests/unit/request-typed.test.ts` — type tests for request + callback linking

### Phase 3: Split `on` into `lifecycle` + `callbacks`
- Modify: `packages/actor-kit/src/core/actor.ts` — `ActorDef` interface
- New handler routing for lifecycle vs callbacks
- Callbacks validated by Zod before handler
- Tests: `tests/unit/lifecycle.test.ts`, `tests/unit/callbacks.test.ts`

### Phase 4: Update outbox to persist meta
- Modify: `packages/actor-kit/src/runtime/outbox.ts`
- Modify: `packages/actor-kit/src/core/actor.ts` — outbox drain delivers meta to callback
- Schema migration: add `meta` column to outbox table
- Tests: integration tests for meta persistence across restart

### Phase 5: Update `testActor()` to support new API
- Modify: `packages/actor-kit/src/test/test-actor.ts`
- `sendWithEffects()` captures typed callback defs
- Tests: `tests/unit/test-actor-callbacks.test.ts`

## Acceptance Criteria

- [ ] `callback()` creates a typed def with name + Zod schemas
- [ ] `request({ onDone: MyCallback })` — compile error if meta doesn't match
- [ ] `callbacks.MY_CALLBACK` handler — result and meta typed from callback def
- [ ] `lifecycle.connect` / `lifecycle.disconnect` — typed `{ caller, callerType }` + ctx
- [ ] meta persists in outbox and survives DO restart
- [ ] `testActor().sendWithEffects()` captures typed callback defs
- [ ] All existing tests pass (lifecycle handlers migrated)
- [ ] Zero `as` casts in new code
- [ ] Zero `any` in new code
