# ADR 019: Hierarchical states, scoped invocations, richer views, and history at scale

**Date**: 2026-10-11
**Status**: Accepted (Jon, 2026-10-11)
**Depends on**: ADR-017 (states), ADR-018 (setup-first, service handles)
**Target release**: 0.3.0

## Context

Flat states drop data on every switch between sibling phases (Run Set Jimmy's `playing.window` / `playing.acting` share a round). A service result can arrive after the actor has moved on, so every `onDone` must re-check state by hand, and multi-step flows with compensation have no structure. View schemas lack signed integers, records, unions and enums, so real game views must be flattened. Journals grow without bound because pruning deletes, and read models must hand-roll dedupe and ordering.

## Decisions

### A. Hierarchical states (no parallel states)
- `state({ local?, enter?, exit?, messages?, timers?, initial?, states? })`. The persisted phase is a path, e.g. `["playing", "window"]`, stored with one `local` per level.
- A parent's `local` survives changes between its children; a level's local is created by its `enter` and dropped on its exit.
- Message lookup walks from the innermost active state outward (innermost wins), then top-level messages. Typed client `send` includes all of them (ADR-018 B).
- `goto(path, shared, input?)` exits up to the least common ancestor and enters down to the target, running each level's `exit`/`enter` in order; `goto` to a parent enters its `initial` child.
- `scope: "state"` timers belong to the level that scheduled them and are cancelled when that level exits.
- Types: `ctx.local` at each level is the intersection of the locals of that level and its ancestors; `goto` checks paths and inputs. Type tests carry a compile-time budget (tsc time measured in CI for the fixtures) so inference cost cannot regress silently.
- Flat ADR-017 states are the depth-1 case; no other change for them.

### B. Scoped invocations
- `ctx.execute(service, input, { scope: "state" })`: when the scheduling level exits, the call is aborted (AbortSignal); a result that still arrives goes to the service's optional `onStale(state, result, input, ctx)` or is journaled as `service.stale` and ignored.
- **Sagas recipe:** each step is a state that executes its call scoped to itself; `onError` goes to a `compensating` state that executes the undo calls in reverse; documented with a tested example (`examples/checkout-saga`).

### C. Richer view schemas
- `int8`, `int16`, `int32` (two's complement, fixed width), `record(value)` (count + key/value; delta per key: added/changed/removed), `union(tag, variants)` (tag byte + variant fields; full variant on tag change, else field delta), `enumOf([...])`/`literal` (small index), and `json(zodSchema)` as an escape hatch (JSON string in the frame, parsed on the client).
- Property-based round-trip tests (fast-check) for `decode(encode(x))` and `apply(prev, delta(prev, next))` on every type, plus nesting.

### D. Journal archive to R2
- `journal: { keep, archive: "R2_BINDING" }`: pruning first writes NDJSON segments (base checkpoint + events, keyed `actorType/actorId/<fromSeq>-<toSeq>.ndjson`) to R2, then deletes locally. Replay, restore and the journal query read archived segments on demand. Studio shows local vs archived ranges and storage size, warning near the per-object cap.
- Property tests: random prune/archive/restore points reproduce the same state and checksums as an unpruned journal.

### E. Read models: `@actor-kit/projection`
- `projection({ queue, db, apply })` wraps a Queue consumer: dedupes on `idempotencyKey`, keeps `last_seq` per actor (D1), applies events in `seq` order per actor (buffers or defers out-of-order ones), and exposes `rebuild()` that replays journals (via the Studio journal API) into a fresh read model.
- **Amended 2026-10-11 (approved by Jon):** `seq` has gaps (a transition that publishes nothing still takes a seq), so a consumer cannot tell a late message from one that never existed. Every published body gains `position`: the actor's published events numbered 1, 2, 3... with no gaps, assigned in the commit transaction (`publish_position` table), never reused or rewound (a restore keeps counting up), and assigned identically by `simulate()`. The projection orders and dedupes on `position` (`idempotencyKey` names the same event); `rebuild()` recomputes positions by counting published events through the journal, in seq order, which matches the live numbering as long as the journal is complete from `init` and `publish.events` has not changed.

### F. Journal query API
- `__journal({ from?, to?, causeType?, event?, correlationId?, limit })` RPC (redacted per ADR-014), exposed through Studio's API, the CLI (`actor-kit studio journal`) and MCP.

## Out of scope
Parallel states; cross-actor transactions; a `saga()` helper (revisit after the recipe); in-actor projections; decider mode.

## Verification
Test-first; nested-state semantics specified as a table of transitions with tests per row; Stryker ≥ 90%; CRAP < 8; full gates; Run Set Jimmy's port is the acceptance test for A–C.
