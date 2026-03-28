# v3 API Redesign Backlog

ADR: docs/adrs/009-v3-api-redesign.md
Spec: docs/specs/v3-api-redesign.md

## Core principle

`defineActor()` returns a typed contract. Everything derives from it.
Actors are pure state machines. Effects go through `emit()` to Queues.
Messages are flat. Guards handle authorization.

## Tasks

- [x] **1. defineActor() + typed contract** — Create `defineActor()` in `packages/worker/src/define.ts`. Returns a typed contract object that preserves TState, TInput, TMessages, TRoles, TViews via generics. The contract is NOT a DO class — it's a plain object with the definition + type info. Create `createActorClass(contract)` that takes the contract and returns the DO class (moves existing `actor()` logic). Write type inference tests first (expectTypeOf): contract.messages should be typed, state should be inferred from init(). Write runtime tests: createActorClass produces a valid DO. TDD: red-green-refactor. Run `pnpm typecheck && pnpm test:unit`.

- [x] **2. Flat messages + role guards** — Change messages from `Record<role, Record<name, MessageDef>>` to `Record<name, MessageDef>`. Update guard signature from `(state) => boolean` to `(state, payload, ctx) => boolean` where ctx has `{ role, caller, callerType, env, emit }`. Update message router to: resolve role → validate payload → check guard(state, payload, ctx) → run handler. Update ActorDef interface. Write tests: guard with ctx.role rejects unauthorized, guard with payload validates content. Run `pnpm typecheck && pnpm test:unit`.

- [x] **3. Remove request/callback/callbacks** — Delete from `@actor-kit/core`: CallbackDef, NormalizedRequestConfig, normalizeRequest. Delete from `@actor-kit/worker`: callback(), request() on MessageContext, callbacks block on ActorDef. Simplify outbox: entries are just Effect (queue/fetch/actor emit). Remove outbox drain effect execution — outbox only delivers to Queues. Delete test files: callback.test.ts, request-typed.test.ts. Update lifecycle-callbacks.test.ts → lifecycle.test.ts. Run `pnpm typecheck && pnpm test:unit`.

- [x] **4. Sync-only handlers** — Change handler return type from `TState | Promise<TState>` to `TState`. Remove `await` from handler invocation in actor.ts. Remove async from lifecycle handlers. Update all test handlers to be sync. Add @ts-expect-error test verifying async handlers are rejected at type level. Run `pnpm typecheck && pnpm test:unit`.

- [x] **5. Delete legacy on block** — Remove `on` from ActorDef interface. Remove on-related code from actor.ts (the fallback paths in connect/disconnect/outbox drain). lifecycle is the only connection handler. Remove request-callbacks.test.ts (tests the old on-based callback delivery). Run `pnpm typecheck && pnpm test:unit`.

- [x] **6. Contract-derived client** — Update `actorClient()` in `@actor-kit/client` to accept a contract (from defineActor) instead of a raw schema. Infer TView from contract.views and TEvent from keyof contract.messages. Remove `.events<E>()` — events are inferred. Remove manual viewSchema option. Update builder.ts and client.ts. Write type tests. Run `pnpm typecheck && pnpm test:unit`.

- [x] **7. Contract-derived React context** — Update `actorContext()` to accept a contract. Infer types from it. Remove manual generics. Write type tests. Run `pnpm typecheck && pnpm test:unit`.

- [x] **8. Contract-derived test harness** — Update `testActor()` to accept a contract. init/send/view/role all typed from contract. No more raw def objects. Write type tests. Run `pnpm typecheck && pnpm test:unit`.

- [x] **9. Contract-derived ref** — Update `createRef()` to accept contract + env + id. ref.send() is typed to the contract's messages. Write type tests. Run `pnpm typecheck && pnpm test:unit`.

- [x] **10. Update integration tests** — Update tests/integration/ for new API: flat messages, defineActor + createActorClass, sync handlers, no request/callbacks. Run `pnpm test:integration`.

- [x] **11. Update examples** — Update all 4 examples (counter, todo-list, chat-room, auction) for v3 API. Counter should be minimal: init + messages only. Run examples to verify.

- [x] **12. Update docs** — Update all 25 docs pages for v3 API. Update installation (simpler), quick-start (minimal counter), concepts (flat messages, guards, emit-only), API reference, examples, recipes. Build docs site.

- [x] **13. Final verification + commit** — Run full suite: pnpm typecheck, pnpm test:unit, pnpm test:integration, pnpm lint, docs build. Commit with detailed message.
