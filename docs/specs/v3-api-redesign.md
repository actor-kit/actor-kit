# Spec: v3 API Redesign

**ADR**: [009-v3-api-redesign](../adrs/009-v3-api-redesign.md)

## Implementation Plan

### Phase 1: defineActor() + typed contract
- New `defineActor()` function that returns a typed contract (not a DO class)
- Contract preserves: TState, TInput, TMessages (names + payload types), TRoles, TViews
- `createActorClass(contract)` converts contract → DO class
- Tests: type inference tests (expectTypeOf) + runtime tests

### Phase 2: Flat messages with role guards
- Remove messages-by-role nesting from ActorDef
- Messages are `Record<string, MessageDef>`
- Guards receive `(state, payload, ctx)` where ctx has `{ role, caller, callerType, env, emit }`
- Update message router to resolve role first, then check guard
- Tests: guard with ctx.role, flat message routing

### Phase 3: Remove request/callback/callbacks
- Delete: `callback()`, `CallbackDef`, `NormalizedRequestConfig`, `normalizeRequest()`
- Delete: `request()` from MessageContext
- Delete: `callbacks` block from ActorDef
- Delete: outbox drain effect execution (keep only Queue emit delivery)
- Simplify outbox: entries are just `{ queue, body }` — no onDone/onError/meta
- Tests: verify emit() still works, verify request() is gone

### Phase 4: Sync-only handlers
- Change handler signature: `(state, payload, ctx) => TState` (no Promise)
- Remove `await` from handler invocation in actor.ts
- Tests: verify sync handlers work, verify async handlers are rejected at type level

### Phase 5: Delete legacy on block
- Remove `on` from ActorDef entirely
- `lifecycle` is the only way to handle connect/disconnect
- Tests: verify lifecycle works, verify on is rejected

### Phase 6: Contract-derived client
- `actorClient(contract)` infers TView and TEvent from the contract
- No more `.events<E>()` — events come from `keyof contract.messages`
- No more manual `viewSchema` — comes from the contract
- Tests: type inference, runtime connection

### Phase 7: Contract-derived React context
- `actorContext(contract)` infers everything from the contract
- Tests: type inference for hooks

### Phase 8: Contract-derived test harness
- `testActor(contract)` fully typed
- Tests: init, send, view, role — all typed from contract

### Phase 9: Contract-derived ref
- `createRef(contract, env, id)` returns typed stub
- `ref.send()` only accepts messages from the contract
- Tests: type inference, send validation

### Phase 10: Update all tests
- Update unit tests for new API
- Update integration tests
- Run full suite

### Phase 11: Update examples + docs
- Update all 4 examples
- Update all 25 docs pages
- Build docs site

## Acceptance Criteria

- [ ] `defineActor()` returns typed contract with full inference
- [ ] Flat messages with guards that receive `(state, payload, ctx)`
- [ ] `emit()` is the only effect primitive — no `request()`
- [ ] Handlers are synchronous — no `Promise<TState>`
- [ ] No `on` block, no `callbacks` block
- [ ] `actorClient(contract)` infers events from contract
- [ ] `actorContext(contract)` infers view + events from contract
- [ ] `testActor(contract)` is fully typed
- [ ] `createRef(contract, env, id)` is fully typed
- [ ] Counter example needs only `init` + `messages` (no roles, no schema)
- [ ] All tests pass
- [ ] Zero `as` casts in new code
