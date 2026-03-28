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

## Task 6: Contract-derived client — DONE

### What was done
- Added contract overload to `actorClient()` in both `@actor-kit/client` and `actor-kit/client`
- `actorClient(contract)` infers TEvent from flat messages (Zod schema `_output`) and TView from view schemas (`SchemaDefinition<TShape>` via `Infer`)
- Kept legacy `actorClient(viewSchema).events<E>()` path for backward compatibility
- Added `ContractEvents<T>` and `ContractView<T>` type helpers — exported from both client packages
- Added per-role `viewSchemas: Record<string, SchemaDefinition>` to `createActorClient` options (P1 fix)
- Client resolves binary schema per role using `roleIndex` from snapshot frame + `activeSchema` tracking for delta frames
- Role names extracted from `Object.keys(contract.def.roles)` to match worker's roleIndex order (P2 fix)
- `ContractEvents` only matches flat messages (values with `schema` property); nested role-based message maps fall through to loose event typing (P2 fix)

### Tests written
- **Unit** (6): contract-client.test.ts — event type inference from flat messages, view type inference, payload validation via @ts-expect-error, subscribe callback typing, multi-view union type, runtime factory behavior

### Codex findings addressed
- [P1] Per-role schemas: `buildContractFactory` extracts ALL view schemas and passes them as `viewSchemas` map to `createActorClient`. Client resolves the correct schema via `roleIndex` → `roleNames` → `viewSchemas[roleName]`. Tracks `activeSchema` for delta frames.
- [P2] Role index alignment: `roleNames` derived from `Object.keys(contract.def.roles)` instead of `Object.keys(contract.def.views)` — matches the worker's `Object.keys(def.roles)` used to compute `roleIndex` in snapshot frames.
- [P2] Nested message safety: `ContractEvents` constraint tightened to `Record<string, { schema: { _output: unknown } }>` — only flat messages (MessageDef with schema) match. Role-nested message maps don't match, so they fall through to loose `{ type: string; [key: string]: unknown }` instead of inferring wrong event names.

## Task 7: Contract-derived React context — DONE

### What was done
- Added contract overload to `actorContext()` in both `@actor-kit/react` and `actor-kit/react`
- `actorContext(contract)` infers TView from `ContractView<T>` and TEvent from `ContractEvents<T>` — same type helpers used by `actorClient(contract)`
- Kept legacy `actorContext<typeof Factory>()` path for backward compatibility
- Implementation delegates to `createActorContext()` — the contract is only used for type inference, not runtime behavior

### Tests written
- **Unit** (5): contract-react.test.ts — view type inference, event type inference from flat messages, useSelector typed view, all hooks returned, multi-view union type

### Codex findings addressed
- [P1] Lockfile sync — pre-existing issue from `@changesets/cli` addition in package.json, not related to task 7 changes
- [P2] Role-scoped message fallback — by design, same as task 6. `ContractEvents` intentionally only handles flat messages (v3 API). Role-nested messages are v2 legacy and fall through to loose typing

## Task 8: Contract-derived test harness — DONE

### What was done
- Added contract overload to `testActor()` in both `@actor-kit/test` and `actor-kit/test`
- `testActor(contract)` returns `ContractTestHarness` with typed `init()`, `send()`, `sendWithEffects()`, `view()`
- Added `ContractState<T>`, `ContractInput<T>`, `ContractEvents<T>`, `ContractView<T>` type helpers locally in each test package
- Contract overload constrained to require `input`, `init`, `roles`, `messages`, `views` — incomplete contracts are rejected
- Detects flat messages (v3) and wraps to role-nested format (same as `createActorClass`)
- Kept legacy `testActor(def)` path for backward compatibility

### Tests written
- **Unit** (10): contract-test-harness.test.ts — input type inference, state type inference, send event typing, sendWithEffects event typing, view data typing, runtime init/send/view flow, guard rejection, emission capture, role resolution, viewer view

### Codex findings addressed
- [P2] Narrowed contract overload constraint to require `roles`, `messages`, `views` (not just `{ name, def }`) — prevents runtime crash on incomplete contracts
- [P2] Changed `ContractInput<T>` to use `_input` instead of `_output` — aligns with `safeParse()` accepting raw values, correct for coercing/transforming Zod schemas
- [P2] Lockfile sync — pre-existing issue from `@changesets/cli` addition, not related to task 8

## Task 9: Contract-derived ref — DONE

### What was done
- Added contract overload to `createRef()` in both `@actor-kit/worker` and `actor-kit/core`
- `createRef(contract, env, id)` returns `ActorRef<ContractEvents<T>>` — `ref.send()` only accepts events from the contract's flat messages
- Added `ContractEvents<T>` type helper locally in each ref module (same pattern as client/react/test)
- `ActorRef` interface now has a generic `TEvent` parameter (defaults to loose `{ type: string; [key: string]: unknown }` for backward compatibility)
- Contract name normalized to UPPER_SNAKE_CASE for env lookup: `"my-actor"` → `"MY_ACTOR"` (hyphens replaced with underscores)
- Detection uses type guards (`isActorContract`, `isDONamespace`) — no `as` casts
- Kept legacy `createRef(env, actorType, actorId)` path for backward compatibility

### Tests written
- **Unit** (8): contract-ref.test.ts — event type inference from flat messages, payload validation via @ts-expect-error, actorType inferred from contract name, send/spawn/getSnapshot delegation, kebab-case name normalization, legacy overload still works

### Codex findings addressed
- [P1] Kebab-case contract names: `"counter-v3".toUpperCase()` → `"COUNTER-V3"` but wrangler binding is `COUNTER_V3`. Fixed by adding `.replace(/-/g, "_")` after `.toUpperCase()`. Applied to both ref.ts copies.
- [P1] Lockfile sync — pre-existing issue from `@changesets/cli` addition, not related to task 9
