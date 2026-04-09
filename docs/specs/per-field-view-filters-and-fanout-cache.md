# Per-Field View Filters & Shared Fan-Out Cache

**Status:** Proposed
**Motivation:** Card games (hidden hands), broadcast-heavy actors (chat, auctions, spectators), and ergonomic per-field authorization.

## Background

Today, view projection and encoding happen **per WebSocket** in `broadcastViews()` (`packages/worker/src/actor.ts:915`):

1. For each connected socket, resolve role.
2. Look up `def.views[role]`.
3. Call `viewDef.fn(state, caller)` — runs N times per broadcast.
4. Diff against `previousViewData.get(ws)` (per-connection map).
5. `encodeDelta(...)` or `encode(...)` — also runs N times.
6. `ws.send(frame)`.

The only existing optimization is a JSON-stringify dedupe key that skips the `send()` if a connection's view is unchanged.

**Gaps:**
- A 100-listener chat room does 100 projections + 100 encodes per message, even though all 100 buffers are byte-identical.
- There is no declarative way to mark a field as "only visible to caller X" — you must hand-write conditional inclusion inside the projection function.
- The encoder always emits all fields declared on the schema; no per-field visibility bitmask.

## Goals

1. **Declarative per-field visibility** via a `filtered()` combinator, so authorization lives next to the data and the encoder can omit hidden fields from the wire entirely.
2. **Shared encoded-buffer cache** during fan-out, so callers in the same visibility bucket with the same prev-frame fingerprint reuse a single encoded buffer.
3. **No wire-format change.** Both features are additive: existing actors keep working with no migration.

## Non-Goals

- No new schema primitives (no `MapSchema`, no `optional`, no `enum` — those belong to other specs).
- No cross-broadcast cache. The cache lives only for the duration of one `broadcastViews()` call.
- No client-side change. The decoder already tolerates absent fields in deltas via the bitmask.

## Design

### Part 1: `filtered()` combinator

New field descriptor in `packages/core/src/schema.ts`:

```ts
interface FilteredDescriptor<F extends FieldDescriptor, TState> {
  readonly kind: "filtered";
  readonly type: "filtered";
  readonly field: F;
  readonly visibleTo: (state: TState, caller: string) => boolean;
}

export function filtered<F extends FieldDescriptor, TState>(
  field: F,
  visibleTo: (state: TState, caller: string) => boolean,
): FilteredDescriptor<F, TState>;
```

Add `"filtered"` to the `FieldDescriptor` union. `Infer<>` unwraps `filtered(F, ...)` to the same TS type as `F` (visibility is a runtime concern, not a type concern — projection still returns the value, the encoder decides whether to emit it).

### Part 2: Visibility key

For a given `(viewDef, state, caller)`, walk the schema and produce a bitmask: one bit per `filtered` field, set iff `visibleTo(state, caller) === true`. Bitmask width = number of `filtered` fields in the schema (cap at 32 for a single uint32; spec to fall back to multi-word if exceeded — likely YAGNI).

```ts
function computeVisibilityKey(view: ViewDef, state: unknown, caller: string): number;
```

This key is the cache bucket. Two callers with the same visibility key get the same encoded bytes.

### Part 3: Encoder changes

`encode()` and `encodeDelta()` in `packages/core/src/binary.ts` and `delta.ts` accept an optional `visibilityMask: number`. For each `filtered` field, the encoder consults the mask:

- **Bit set:** encode normally.
- **Bit clear:** skip the field — in delta encoding, the bitmask omits it (no bytes written); in snapshot encoding, write a zero/absent marker per the existing absent-field convention.

The decoder needs no change — it already handles "field not present in this delta" via the existing bitmask.

### Part 4: Fan-out cache in `broadcastViews()`

Restructure the loop in `packages/worker/src/actor.ts:915` from "per socket: project, diff, encode, send" to:

```
1. Group sockets by role.
2. For each role bucket:
   a. Compute viewData = viewDef.fn(state, /* representative caller */)
      - SAFETY: only valid if the projection function does NOT read `caller`.
      - Detect this by either (a) marking views as "shared" explicitly via
        `view.shared(...)` vs `view.perCaller(...)`, or (b) running the
        projection once and caching by referential equality. Prefer (a) —
        explicit is better than runtime sniffing.
   c. For each socket in the bucket:
      - visKey = computeVisibilityKey(viewDef, state, caller)
      - prevHash = connection.prevFrameHash
      - cacheKey = `${role}:${visKey}:${prevHash}`
      - if cache.has(cacheKey): reuse buffer, send, update prevHash
      - else: encode(viewData, visKey, prevFrame), cache, send, update prevHash
3. Per-caller views (e.g. card-game `myHand`) bypass the cache entirely
   and run the existing per-socket path.
```

This requires a new explicit distinction in the API:

```ts
// Shared — projection MUST NOT read `caller`. Cached across role bucket.
view.shared(schema, (state) => ({ ... }))

// Per-caller — projection may read `caller`. Not cached.
view.perCaller(schema, (state, caller) => ({ ... }))
```

Or, less invasive: keep `view(schema, fn)` and add a `view.shared(...)` helper that omits `caller` from the projection signature at the type level.

### Part 5: Two-tier views (optional, follow-up)

For card games, the natural pattern is:
- `PublicGameView` — shared across all players (cached, 1 encode per visibility bucket).
- `PrivateHandView` — per caller (not cached, N encodes for N players).

This can be a follow-up: allow an actor to declare *multiple* views per role, each broadcast independently. Out of scope for the first cut; document as future work.

## Impact

- **Chat room (100 listeners, no filters):** 100 projections + 100 encodes → **1 projection + 1 encode** per message.
- **Auction (50 bidders + 1 admin, `reservePrice` filtered):** 51 projections + 51 encodes → **1 projection + 2 encodes** (one per visibility bucket).
- **Card game (4 players, `myHand` per-caller):** unchanged at 4 projections + 4 encodes — but the privacy is now declarative via `filtered()` instead of conditional projection logic.

## Test Plan (TDD)

### Unit tests (`tests/unit/`)

1. `filtered.test.ts`
   - `filtered(uint32, predicate)` returns a FilteredDescriptor with correct shape.
   - `Infer<>` of a schema containing `filtered(uint32, ...)` produces `number`, not `number | undefined`.
   - Nested: `array(filtered(...))` and `filtered(schema({...}), ...)` both compose.

2. `visibility-key.test.ts`
   - Empty schema → key 0.
   - Single `filtered` field, predicate true → bit 0 set.
   - Multiple `filtered` fields → independent bits.
   - Predicate that depends on `state` flips correctly.
   - Predicate that depends on `caller` flips correctly.

3. `encoder-visibility.test.ts`
   - Snapshot encode with bit clear → field absent from output, decode yields previous value (or undefined on first frame).
   - Delta encode with bit clear → field omitted from delta bitmask.
   - Visibility flip (false → true) between frames → next delta includes the field as a fresh value.
   - Visibility flip (true → false) → next delta omits the field; client retains last seen value (document this as the contract).

### Integration tests (`tests/integration/`)

4. `view-filters.test.ts` (vitest-pool-workers)
   - Two clients connected to the same actor, one in role with `filtered` field visible, one without.
   - Assert client A's frames contain the field bytes; client B's frames do not (inspect raw `Uint8Array`).
   - Trigger a state change that flips the predicate; assert the next delta to client B contains the newly-revealed field.

5. `fanout-cache.test.ts`
   - Spy on `encode` / `encodeDelta` calls during a `broadcastViews()`.
   - 10 sockets in the same role with no `filtered` fields → assert encode called **once**.
   - 10 sockets split across 2 visibility buckets → assert encode called **twice**.
   - 10 sockets, one with a stale `prevFrameHash` (simulated reconnect mid-broadcast) → that socket triggers an extra encode; the rest still share.

6. `card-game.test.ts`
   - Build a minimal 4-player trick-taking actor in `tests/integration/src/`.
   - Each player connects, deals hands.
   - Assert player A's frames contain A's hand bytes; B/C/D frames do not (raw bytes inspection).
   - Player A plays a card; assert all four players see the updated `trick`, only A sees the updated `myHand`.
   - Reveal the kitty (phase transition); assert all players' next delta contains the kitty.

### Mutation testing (Stryker)

7. Run Stryker against `packages/core/src/schema.ts`, `binary.ts`, `delta.ts` and the new visibility logic. Target: kill all survivors. Expected weak spots:
   - Off-by-one in bitmask shifts.
   - Inverted predicates (`!visibleTo` vs `visibleTo`).
   - Cache key collisions (mutate the key separator).

## Risks & Open Questions

- **Cache key collisions across schema versions:** if the actor migrates state and the view shape changes mid-session, the cache must be invalidated. The current `version` field on frames already handles this — confirm the cache lives within a single broadcast call and so cannot leak across versions.
- **`view.shared` vs `view.perCaller` API split:** does this complicate the common case? Alternative: keep `view(...)` as the only entry point and use a type-level marker. Decide during implementation; lean toward explicit.
- **Bitmask width:** 32 bits = 32 filtered fields per view. If we ever exceed this, fall back to a `Uint8Array` mask. Document the limit in the JSDoc; don't build the fallback yet.
- **DOM-style visibility events:** when a field becomes visible mid-session (kitty reveal), should the client get a synthetic "field appeared" event? Or is the next delta enough? Decision: next delta is enough — the decoder already updates state from the bitmask.
- **Per-caller view detection:** if we keep `view(schema, fn)` as a single API, how do we know whether `fn` reads `caller`? Options: (a) Function.length, (b) explicit `view.shared(...)` API, (c) run twice with different callers and compare outputs (slow). Recommend (b).

## Rollout

1. Land `filtered()` combinator + visibility key + encoder changes behind existing API. No behavior change yet (broadcastViews still per-socket).
2. Land tests for `filtered()` end-to-end.
3. Add `view.shared(...)` API.
4. Restructure `broadcastViews()` to use the cache. Gate behind a feature flag for one release if nervous; remove flag after integration tests pass on all examples.
5. Update `examples/auction` to use `filtered()` for the reserve price.
6. Add a card-game example under `examples/` to exercise the per-caller path.

## References

- Current fan-out: `packages/worker/src/actor.ts:915-984`
- Current view API: `packages/core/src/view.ts`
- Current schema builder: `packages/core/src/schema.ts`
- Current encoders: `packages/core/src/binary.ts`, `packages/core/src/delta.ts`
- Comparable system: Colyseus `@filter` decorators and `StateView` in `~/src/colyseus/packages/core/src/serializer/SchemaSerializer.ts`
