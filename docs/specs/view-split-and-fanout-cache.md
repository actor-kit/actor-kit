# View Split & Shared Fan-Out Cache

**Status:** Proposed
**Motivation:** Broadcast-heavy actors (chat rooms, auctions, spectators) re-project and re-encode identical data per WebSocket. Explicit `view.shared` / `view.perCaller` enables a simple fan-out cache keyed by role.

## Background

Today, view projection and encoding happen **per WebSocket** in `broadcastViews()` (`packages/worker/src/actor.ts:915`):

1. For each connected socket, resolve role.
2. Look up `def.views[role]`.
3. Call `viewDef.fn(state, caller)` — runs N times per broadcast.
4. Diff against `previousViewData.get(ws)` (per-connection map).
5. `encodeDelta(...)` or `encode(...)` — also runs N times.
6. `ws.send(frame)`.

The only existing optimization is a JSON-stringify dedupe key that skips the `send()` if a connection's view is unchanged.

**Gap:** A 100-listener chat room does 100 projections + 100 encodes per message, even though all 100 buffers are byte-identical.

## Goals

1. **Explicit view split** — `view.shared` (no `caller`) and `view.perCaller` (receives `caller`) as the only two view constructors. Type-enforced: `view.shared` callback literally cannot reference `caller`.
2. **Shared encoded-buffer cache** for `view.shared` views during fan-out. Same-role sockets with the same previous-frame fingerprint reuse a single encoded buffer.
3. **No wire-format change.** The cache is a runtime optimization in `broadcastViews()`. The binary protocol is unchanged.

## Non-Goals

- No `filtered()` combinator. Role-keyed views already handle per-field visibility. See "Decisions" section below.
- No sub-field / element-level caching. For high-fan-out unique-per-caller scenarios (fog-of-war), the recommended pattern is multi-actor spatial partitioning, not framework-level encoding tricks.
- No cross-broadcast cache. The cache lives only for the duration of one `broadcastViews()` call.
- No `view()` alias or backward-compatibility shim. `view.shared` and `view.perCaller` are the only entry points.

## Decisions Made (from grill-me)

1. **`filtered()` dropped.** Role-keyed views already provide per-field visibility with full type safety — the bidder role's schema doesn't include `reservePrice`, so the client type doesn't have it. `filtered()` would have introduced a parallel, weaker authorization model alongside roles.

2. **Explicit split over arity detection.** `fn.length` is brittle (transpilers, destructuring, unused params). The split makes cacheability a type-level contract, consistent with actor-kit's offensive-typesafety philosophy.

3. **No `view()` alias.** No backwards compatibility needed — this is a greenfield API.

4. **Per-caller views are not cached.** Card-game hands, fog-of-war — each caller gets unique projected data. These stay on the existing per-socket path. The fan-out cache only applies to `view.shared`.

## Design

### `view.shared` and `view.perCaller`

Replace the current `view()` function in `packages/core/src/view.ts`:

```ts
export interface SharedViewDef<TState, TShape extends Record<string, FieldDescriptor>> {
  readonly kind: "shared";
  readonly schema: SchemaDefinition<TShape>;
  readonly fn: (state: TState) => Infer<SchemaDefinition<TShape>>;
}

export interface PerCallerViewDef<TState, TShape extends Record<string, FieldDescriptor>> {
  readonly kind: "perCaller";
  readonly schema: SchemaDefinition<TShape>;
  readonly fn: (state: TState, caller: string) => Infer<SchemaDefinition<TShape>>;
}

export type ViewDef<TState, TShape extends Record<string, FieldDescriptor>> =
  | SharedViewDef<TState, TShape>
  | PerCallerViewDef<TState, TShape>;

export const view = {
  shared<TState, TShape extends Record<string, FieldDescriptor>>(
    schemaArg: SchemaDefinition<TShape>,
    fn: (state: TState) => Infer<SchemaDefinition<TShape>>,
  ): SharedViewDef<TState, TShape> {
    return { kind: "shared", schema: schemaArg, fn };
  },

  perCaller<TState, TShape extends Record<string, FieldDescriptor>>(
    schemaArg: SchemaDefinition<TShape>,
    fn: (state: TState, caller: string) => Infer<SchemaDefinition<TShape>>,
  ): PerCallerViewDef<TState, TShape> {
    return { kind: "perCaller", schema: schemaArg, fn };
  },
};
```

Usage:

```ts
views: {
  // Chat: everyone sees the same messages — cached
  member: view.shared(ChatView, (state) => ({
    messages: state.messages.slice(-50),
    memberCount: state.members.length,
  })),

  // Card game: each player sees their own hand — not cached
  player: view.perCaller(PlayerView, (state, caller) => ({
    myHand: state.hands[caller],
    trick: state.trick,
    scores: state.scores,
  })),

  // Spectator: everyone sees the same board — cached
  spectator: view.shared(SpectatorView, (state) => ({
    trick: state.trick,
    scores: state.scores,
    handSizes: Object.fromEntries(
      state.players.map(p => [p, state.hands[p].length])
    ),
  })),
}
```

### Fan-out cache in `broadcastViews()`

Restructure the loop in `packages/worker/src/actor.ts:915`:

```
broadcastViews() fires after a state transition

cache = new Map<string, Uint8Array>()  // lives for this broadcast only

Group sockets by role.

For each role:
  viewDef = def.views[role]

  if viewDef.kind === "shared":
    // 1. Project ONCE
    viewData = viewDef.fn(state)
    dedupeKey = `${role}:${JSON.stringify(viewData)}`

    // 2. Group sockets by prevFrameHash
    groups = groupBy(sockets, ws => prevFrameHash.get(ws))

    // 3. For each group: encode ONCE, send to all
    for (hash, group) of groups:
      cacheKey = `${role}:${hash}`
      
      // Check dedupe — skip entirely if unchanged for this group
      if all sockets in group have prevDedupeKey === dedupeKey:
        continue

      buf = cache.get(cacheKey)
      if !buf:
        prevFrame = representative socket's previousViewData
        buf = encodeDelta(schema, prevFrame, viewData) ?? encodeSnapshot(...)
        cache.set(cacheKey, buf)
      
      for ws in group:
        ws.send(buf)
        update prevFrameHash, previousViewData, previousViews for ws

  if viewDef.kind === "perCaller":
    // Existing per-socket path — no cache
    for ws in sockets:
      viewData = viewDef.fn(state, caller)
      // dedupe, diff, encode, send (same as today)
```

### `prevFrameHash` tracking

Add a `prevFrameHash: Map<WebSocket, number>` alongside the existing `previousViewData` map. After each successful send, hash the encoded buffer (cheap CRC32 or FNV-1a) and store it. This is what groups sockets into cache buckets.

In practice, most steady-state sockets converge to the same `prevFrameHash` after 1-2 frames. The only divergence is newly connected clients or clients that missed a frame (which triggers a full snapshot, after which they converge).

## Impact

| Scenario | Today | After |
|---|---|---|
| Chat room, 100 listeners | 100 projections + 100 encodes | 1 projection + 1-2 encodes |
| Auction, 50 bidders + 1 admin | 51 projections + 51 encodes | 2 projections + 2-3 encodes |
| Card game, 4 players (perCaller) | 4 projections + 4 encodes | 4 projections + 4 encodes (unchanged) |
| Counter, 1 user | 1 projection + 1 encode | 1 projection + 1 encode (unchanged) |

## Test Plan (TDD)

### Unit tests (`tests/unit/`)

1. `view-split.test.ts`
   - `view.shared(schema, fn)` returns a `SharedViewDef` with `kind: "shared"`.
   - `view.perCaller(schema, fn)` returns a `PerCallerViewDef` with `kind: "perCaller"`.
   - Type test: `view.shared` callback with 2 params is a compile error.
   - Type test: `view.perCaller` callback with 1 param is a compile error.
   - `SharedViewDef.fn` called with `(state)` returns projected data.
   - `PerCallerViewDef.fn` called with `(state, caller)` returns projected data.

### Integration tests (`tests/integration/`)

2. `fanout-cache.test.ts` (vitest-pool-workers)
   - Actor with `view.shared`. Connect 10 clients in the same role.
   - Send a message that changes state.
   - Spy on `encode` / `encodeDelta` calls — assert called **once** (not 10 times).
   - All 10 clients receive byte-identical frames.

3. `fanout-cache-mixed.test.ts`
   - Actor with one `view.shared` role and one `view.perCaller` role.
   - Connect 5 shared clients + 3 perCaller clients.
   - State transition.
   - Shared: encode called once. PerCaller: encode called 3 times.

4. `fanout-cache-reconnect.test.ts`
   - 5 shared clients, all in sync.
   - Disconnect client 3, reconnect (gets fresh snapshot → different `prevFrameHash`).
   - Next state transition: encode called **twice** — one for the 4 converged clients, one for the reconnected client.
   - After one more transition: all 5 converge, encode called once.

5. `fanout-cache-role-change.test.ts`
   - Client starts in role A (shared), state transition causes role change to B (shared, different schema).
   - Assert client receives a full snapshot for role B, not a delta from role A.
   - Assert other role A clients are unaffected.

6. `view-shared-examples.test.ts`
   - Migrate existing `examples/counter` and `examples/chat-room` to use `view.shared`.
   - All existing integration tests pass unchanged.

7. `view-percaller-examples.test.ts`
   - `examples/todo-list` (owner sees all, guest sees public) uses `view.perCaller` for owner, `view.shared` for guest.
   - Existing tests pass.

### Mutation testing (Stryker)

8. Run Stryker against the fan-out cache logic. Expected weak spots:
   - Cache key construction (separator mutation → collisions).
   - `kind === "shared"` check flipped → perCaller views cached incorrectly.
   - `prevFrameHash` not updated after send → stale cache hits on next broadcast.
   - Group-by logic produces wrong buckets → wrong deltas sent.

## Risks & Open Questions

- **`prevFrameHash` collision:** FNV-1a on encoded buffers gives 32-bit hashes. Collision probability is negligible for realistic socket counts per actor (~1 in 4 billion). If paranoid, use 64-bit.
- **Memory pressure from cache:** the cache holds at most `(number of roles) * (number of prevFrameHash buckets)` encoded buffers, all freed at the end of `broadcastViews()`. Negligible.
- **JSON.stringify dedupe vs. cache:** the existing `JSON.stringify(viewData)` dedupe in `broadcastViews()` skips the send entirely when view data is unchanged. This optimization should be preserved — check dedupe *before* hitting the cache. For shared views, the stringify runs once (one projection), so it's cheap.

## Rollout

1. Implement `view.shared` / `view.perCaller` in `packages/core/src/view.ts`. Update `ViewDef` type and exports.
2. Update `packages/worker/src/actor.ts` to handle `kind: "shared"` vs `kind: "perCaller"` in `broadcastViews()`. Initially both run the existing per-socket path — no cache yet. All existing tests pass.
3. Add `prevFrameHash` tracking to the connection state.
4. Implement the fan-out cache for `view.shared` views.
5. Migrate examples to use `view.shared` / `view.perCaller`.
6. Mutation test pass. Kill survivors.

## References

- Current fan-out: `packages/worker/src/actor.ts:915-984`
- Current view API: `packages/core/src/view.ts`
- Companion spec: `docs/specs/nullable-schema-fields.md`
