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

### F. Journal query API
- `__journal({ from?, to?, causeType?, event?, correlationId?, limit })` RPC (redacted per ADR-014), exposed through Studio's API, the CLI (`actor-kit studio journal`) and MCP.

## Out of scope
Parallel states; cross-actor transactions; a `saga()` helper (revisit after the recipe); in-actor projections; decider mode.

## Verification
Test-first; nested-state semantics specified as a table of transitions with tests per row; Stryker ≥ 90%; CRAP < 8; full gates; Run Set Jimmy's port is the acceptance test for A–C.

## A as built: nested-state semantics (2026-10-11)

**Shape.** `state({ local?, enter?, exit?, messages?, timers?, initial?, states? })` at every level;
`setup({ states })` declarations nest the same way (`{ local?, input?, states? }`). The persisted state
of an actor with states is `{ shared, phase, locals, stateTimers }`: `phase` is the active path from the
root to a leaf (`["playing", "window"]`), `locals[i]` is the local of level `i` (`null` when it declares
none) and `stateTimers[i]` the keys of the `scope: "state"` timers level `i` owns. A flat actor is the
depth-1 case: `{ shared, phase: ["round"], locals: [{ n: 1 }], stateTimers: [["round:roundEnd"]] }`.
The 0.2 shape `{ shared, phase: "round", local, stateTimers }` is read as the one-element path and
rewritten in the new shape when the Durable Object loads it.

**Terms.** *Level k* of a path is its prefix of length k. A handler runs *at* the level that declares
it (a top-level message or timer runs at the leaf). *merge(L₁…L_k)* is the local a handler at level k
sees: the levels' locals spread root first (inner keys win), `null` levels skipped; a single non-null
local is passed as it is; none gives `null`. Paths are absolute: `"round"` means `["round"]`.

| # | Situation | Result |
|---|---|---|
| 1 | init | Enter the root `initial`, then each entered level's `initial` child, down to a leaf. No `enter` runs (no input exists yet), so no level on that chain may declare a local (`initial_state_local`); a level with `states` and no `initial` fails (`missing_initial`). |
| 2 | message sent | Looked up innermost first along the active path, then in the role's top-level messages; the first hit handles it, at its level. |
| 3 | message declared only off the active path | Refused `wrong_state` before its guard; `acceptedIn` lists the declaring paths, dotted (`playing.acting`). |
| 4 | guard / handler context | `ctx.phase` is the whole active path; `ctx.local` is merge(locals up to the handler's level). |
| 5 | handler returns the shared state, or `ctx.stay(shared)` | Shared replaced; every level's local and timers kept. |
| 6 | `ctx.stay(shared, local)` from level k | Each level ≤ k that declares a local parses `local` with its own schema (a `z.object` keeps its own keys), so one merged value updates every level it covers. Deeper levels are untouched. |
| 7 | `ctx.goto(target, shared, input?)` | Kept = the longest common prefix of the active path and `target`, at most `target.length - 1` long: **the target level itself is always entered**, even when active. Exit the active levels below Kept (innermost first), enter `target`'s levels below Kept (outermost first), then each entered level's `initial` child down to a leaf. |
| 8 | goto a sibling (`["playing","window"]` → `["playing","acting"]`) | Exit `window`, enter `acting`. `playing`'s local and its timers survive. |
| 9 | goto another branch (`["playing","acting"]` → `["over"]`) | Exit `acting`, exit `playing`, enter `over`. |
| 10 | goto the active leaf (`["playing","window"]` → itself; flat: `"round"` → `"round"`) | Exit and re-enter it: its timers are cancelled, `enter` runs again (ADR-017 behaviour). The parent is kept. |
| 11 | goto an active ancestor (`["playing","window"]` → `["playing"]`) | Exit `window` and `playing`, enter `playing` (with the input) and its `initial` child. |
| 12 | goto into a parent from outside (`["lobby"]` → `["playing"]`) | Exit `lobby`, enter `playing` with the input, then its `initial` child with no input. |
| 13 | goto a deep path from outside (`["lobby"]` → `["playing","acting"]`) | Exit `lobby`, enter `playing`, enter `acting`. The input goes to the target (`acting`); a level entered on the way gets `undefined`, and one that declares `input` fails (`missing_state_input`). |
| 14 | exit of level k | `exit(shared, ctx)` runs (ctx.local = merge up to k) and returns the next shared state; then level k's `scope: "state"` timers are cancelled and its local dropped. `exit` cannot schedule a `scope: "state"` timer (`invalid_schedule`) or `goto`. |
| 15 | enter of level k | `enter(shared, input, ctx)` runs with ctx.local = merge of the levels above it; it returns level k's local, or `ctx.stay(shared, local)` to change the shared state too (Run Set Jimmy feedback 8). A `goto` from `enter` fails (`invalid_transition`). |
| 16 | `ctx.schedule(name, { scope: "state" })` at level k (handler or `enter`) | The timer is looked up innermost first from level k, then top-level. Level k owns it; its key defaults to `"<dotted level path>:<name>"` (flat: `round:roundEnd`). |
| 17 | a timer fires | Looked up innermost first along the active path, then top-level; its handler runs at that level and its key leaves whichever level owned it. A timer whose level is no longer active (a plain-scoped one) is a no-op, as before. |
| 18 | top-level messages and timers, lifecycle, service and link callbacks | See and return the shared state; locals, path and timers are kept. |
| 19 | goto a path that is not declared | `undeclared_state`. |
| 20 | merge of two non-null locals that are not both objects | `invalid_local`: nested locals must be objects (`z.object`). |

Views and roles get the persisted state. `matches(state, path)` narrows it by a path prefix
(`matches(s, "playing")`, `matches(s, ["playing", "window"])`) and `localOf(state)` returns the merged
local of the active path, typed. Studio's timeline marks phase changes with the dotted path.
