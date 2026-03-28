# Progress
Working memory for v3 API redesign. Delete after run.
---

## Task 1: defineActor() + typed contract — DONE

### What was done
- Created `packages/worker/src/define.ts` with `defineActor()` and `ActorContract` type
- Added `createActorClass()` to `packages/worker/src/actor.ts` using a type guard (`isActorDef`) to bridge typed contracts to the runtime `ActorDef` interface
- Exported from both `@actor-kit/worker` and `@actor-kit/worker/testing`

### Tests written
- **Unit** (9): type inference (name, state, roles, messages, views, ActorContract) + runtime
- **Integration** (4): spawn, persist, role auth, views — all via vitest-pool-workers

### Codex findings addressed
- [P2] Added `input: ZodType` to defineActor constraint — prevents runtime crash on spawn

## Task 2: Flat messages + role guards — DONE

### What was done
- Added `GuardContext` type to `@actor-kit/core` — guards receive `(state, payload, ctx)` where ctx has `{ role, caller, callerType, env, emit }`
- Updated `GuardFn` to accept `(state, payload, ctx)` — old 1-param guards still work (JS ignores extra args, TS allows fewer params)
- Updated `RoutableMessage.guard` and `ActorMessageSlot.guard` bivariant method signatures to 3 params
- Updated `routeMessage()` in both packages to pass `(state, parsedPayload, ctx)` to guards (ctx built before guard check)
- `createActorClass()` detects flat messages (checks all entries for `schema` + `handler`) and wraps into role-nested format where every role gets all messages
- Flat messages: `Record<name, MessageDef>` instead of `Record<role, Record<name, MessageDef>>`

### Tests written
- **Integration** (5): flat-messages.test.ts — guard with ctx.role rejects unauthorized, guard with ctx.role allows authorized, guard with payload validates content, flat messages available to all roles, open messages without guards

### Codex findings addressed
- [P2] `isFlatMessages()` now checks all entries for both `schema` AND `handler` — prevents false positive when v2 role name is "schema"

## Task 3: Remove request/callback/callbacks — DONE

### What was done
- Deleted `CallbackDef`, `NormalizedRequestConfig`, `normalizeRequest`, `RequestConfig`, `RequestFn` from `@actor-kit/core` and `@actor-kit/actor-kit`
- Deleted `callback()` function from `@actor-kit/worker` (both `callback.ts` files removed)
- Removed `request` from `MessageContext` — handlers only have `emit()` for side effects
- Removed `callbacks` block from `ActorDef` interface in both actor.ts copies
- Simplified outbox: removed `request()` method, `OutboxEntry` is now just `{ id, payload, status, attempts, createdAt }` (no type/onDone/onError/meta)
- Simplified `drainOutboxInner()` — no callback invocation on drain, just effect execution + mark sent
- Simplified `persistOutbox()` — no onDone/onError/meta columns
- Cleaned up `CREATE_TABLES_SQL` — removed `on_done`, `on_error`, `meta` columns from outbox table
- Updated `testActor()` in both `@actor-kit/test` and `@actor-kit/actor-kit` — `sendWithEffects` returns `{ state, emissions }` only (no `requests`)
- Updated all exports: removed callback/request types from `@actor-kit/core`, `@actor-kit/worker`, `@actor-kit/worker/testing`

### Tests written
- **Unit** (lifecycle.test.ts): lifecycle handlers work, sendWithEffects returns emissions only (no requests property)
- **Unit** (outbox.test.ts): updated — removed request() tests, kept emit-only tests
- **Unit** (message.test.ts): updated — removed `ctx.request` assertions, updated async handler test to use `emit()`

### Tests deleted
- callback.test.ts, request-typed.test.ts, request-callbacks.test.ts, lifecycle-callbacks.test.ts

### Codex findings addressed
- [P1] Cleaned up CREATE_TABLES_SQL to remove unused on_done/on_error/meta columns from outbox table
- [P2] Acknowledged: Effect type intentionally keeps fetch/actor variants for the transition period — actors can use emit({fetch:...}) for fire-and-forget HTTP. Queue-only enforcement is a future concern, not task 3 scope

## Task 4: Sync-only handlers — DONE

### What was done
- Changed handler return type from `TState | Promise<TState>` to `TState` in `MessageDef`, `MessageHandler`, `MessageContext` across `@actor-kit/core`, `@actor-kit/worker`, `@actor-kit/actor-kit`
- Made `routeMessage()` synchronous in both message-router.ts copies (removed `async`, removed `await`)
- Removed `await` from handler invocations in both actor.ts copies: lifecycle.connect, lifecycle.disconnect, after handlers, tick.handler
- Updated `ActorDef` interface in both actor.ts copies: lifecycle/on/after/tick return `unknown` (not `unknown | Promise<unknown>`)
- Updated `TestableActorDef` in both test harness copies: lifecycle/on return `TState` (not `TState | Promise<TState>`)
- Updated `RoutableMessage.handler` return type from `unknown` to `TState` (eliminates cast)
- Added runtime `instanceof Promise` guards in routeMessage and all handler invocation sites (connect, disconnect, after, tick) — prevents async handlers from silently corrupting state even when bypassing the type system (JS consumers, structural typing)

### Tests written
- **Unit** (message.test.ts): `@ts-expect-error` test verifying async handlers are rejected at type level via `message()` helper

### Codex findings addressed
- [P1] Added `instanceof Promise` runtime guard in routeMessage — prevents async handlers that slip past the type system (JS consumers, structural typing via `actor()`) from silently storing Promise objects as actor state
- [P2] Added `instanceof Promise` runtime guards in all lifecycle/after/tick handler invocation sites in both actor.ts copies — same defense against async functions assignable to `(...) => unknown`
