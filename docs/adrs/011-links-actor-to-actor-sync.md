# ADR 011: Links — Actor-to-Actor State Sync

**Date**: 2026-03-30
**Status**: Accepted
**Depends on**: ADR-010 (services + execute)

## Context

Actors need to read and stay in sync with other actors' state. Today, the only way to achieve this is through the client acting as broker — the client opens WebSocket connections to both actors and relays state between them. In production (remix-workers-app), this manifests as: Player DO <--WS--> Client XState <--WS--> Profile DO. If the client disconnects mid-flow, state sync is lost. The broker pattern is fragile, adds latency (two hops through the client), and forces the client to understand the relationship between actors that should be a server-side concern.

Three recurring use cases drive the design:

1. **Static dependencies** — Player always needs Profile data from birth (profileId comes from input). The dependency exists for the actor's entire lifetime.
2. **Dynamic dependencies** — Player joins a Game mid-lifecycle (gameId arrives via a message). The dependency is created and destroyed at runtime.
3. **Collections** — Game needs N player profiles (players join and leave). Multiple instances of the same actor type, managed as a set.

An additional constraint: the same subscriber may have different roles on different instances of the same actor type (e.g., admin on game-1, player on game-2). The solution must handle mixed roles without requiring the subscriber to declare which role it expects.

## Decision

Add a `link()` declaration and `ctx.link()` / `ctx.unlink()` runtime operations for push-based actor-to-actor state sync.

### Declaration

A `links` block in the actor definition declares which actor types this actor CAN link to, along with handlers for updates, errors, and cleanup:

```typescript
import { link } from "@actor-kit/worker";

defineActor("player", {
  links: {
    profile: link(ProfileContract, {
      onUpdate: (state, view) => ({ ...state, profile: view }),
      onError: (state, error) => ({ ...state, profileError: error.message }),
    }),
    game: link(GameContract, {
      onUpdate: (state, view, gameId) => ({
        ...state,
        games: { ...state.games, [gameId]: view },
      }),
      onError: (state, error, gameId) => ({
        ...state,
        gameErrors: { ...state.gameErrors, [gameId]: error.message },
      }),
      onUnlink: (state, gameId) => {
        const { [gameId]: _, ...rest } = state.games;
        return { ...state, games: rest };
      },
    }),
  },
});
```

`link(contract, handlers)` accepts:
- `contract` — the target actor's contract (from `defineActor()`). Provides type information and the env binding name.
- `onUpdate(state, view, id?)` — pure reducer. `view` is `LinkedView<TContract>` (discriminated union). `id` present for collections.
- `onError(state, error, id?)` — source unreachable, destroyed, or revoked access. `error.code`: `"not_found" | "unauthorized" | "unreachable"`.
- `onUnlink(state, id?)` — cleanup when the source is explicitly unlinked or destroyed.

### No role in the declaration

The target actor resolves the subscriber's role on every push, exactly as it does for WebSocket clients. The subscriber receives a **discriminated union** of all possible views, with `role` as the discriminant:

```typescript
type LinkedView<typeof GameContract> =
  | { role: "admin";     players: Player[]; settings: Settings; revenue: number }
  | { role: "player";    players: Player[]; myScore: number }
  | { role: "spectator"; players: Player[] }
```

Fields common to all variants (e.g., `players`) are accessible without narrowing. Role-specific fields require a `switch` on `view.role`.

### Runtime: ctx.link() and ctx.unlink()

**In init** — `await link(name, id)` fetches the initial view and subscribes. Returns the typed view (non-nullable). If the fetch fails, init throws and the actor never initializes:

```typescript
init: async (input, env, { link }) => {
  const profile = await link("profile", input.profileId);
  return { profileId: input.profileId, profile, game: null };
},
```

**In message handlers** — `link(name, id)` is fire-and-forget. It subscribes to the target; the first view arrives asynchronously via `onUpdate`. `unlink(name, id)` removes a specific subscription. `unlink(name)` removes all subscriptions under that link name:

```typescript
messages: {
  JOIN_GAME: message(z.object({ gameId: z.string() }), (state, { gameId }, { link }) => {
    link("game", gameId);
    return { ...state, gameId, gameStatus: "connecting" };
  }),
  LEAVE_GAME: message(z.object({ gameId: z.string() }), (state, { gameId }, { unlink }) => {
    unlink("game", gameId);
    return { ...state, gameStatus: "disconnected" };
  }),
}
```

`ctx.link` is generic over declared link names — `link("typo", id)` is a compile error.

### Collections

Same API. Call `link(name, id)` with different IDs under the same link name. Handlers receive `id` as third arg. Different instances can resolve to different roles (admin on game-1, player on game-2) because the target resolves the role per-instance.

### Caller identity

Links use `callerType: "service"` — an actor subscribing to another actor IS a service call. No new callerType needed. The `caller` string encodes the subscriber: `"player:<do-id>"`.

### Framework execution model

**Source side** — When a source actor's state changes, `broadcastViews()` sends to both WebSocket clients and DO subscribers. DO subscribers get outbox entries: `{ type: "link_push", subscriber_type, subscriber_id, view, version }`. The source recomputes the subscriber's role on every push (no persisted role). Outbox entries are persisted atomically with the state change, drained async after commit, retried on crash. Existing checksum deduplication in `broadcastViews()` naturally dampens cycles: if the view hasn't changed, the push is skipped.

**Subscriber side** — When a link update arrives via RPC: (1) look up the link handler, (2) check monotonic version (skip if stale), (3) run `onUpdate(currentState, newView, id)` as a pure reducer, (4) persist new state, (5) broadcast own views to own clients and DO subscribers.

### Persistence

**Subscriber: `active_links` table** — keyed by target actor, not link name:

```sql
CREATE TABLE IF NOT EXISTS active_links (
  target_type TEXT,
  target_id TEXT,
  link_name TEXT,
  version INTEGER DEFAULT 0,
  created_at INTEGER,
  PRIMARY KEY (target_type, target_id, link_name)
);
```

On restart: read `active_links`, re-register subscriptions on target actors, receive fresh views, `onUpdate` fires for each that changed.

**Source: `link_subscribers` table**:

```sql
CREATE TABLE IF NOT EXISTS link_subscribers (
  subscriber_type TEXT,
  subscriber_id TEXT,
  subscribed_at INTEGER,
  PRIMARY KEY (subscriber_type, subscriber_id)
);
```

No role or link name stored on the source. The source just knows "PLAYER:alice is subscribed" and recomputes everything on push.

### React integration

The same discriminated union pattern extends to React clients:

- `useView()` — returns the full `LinkedView<TContract> | undefined`
- `useRole()` — returns just the discriminant: `"admin" | "player" | "spectator" | undefined`
- `useSelector(fn)` — selects from the full union (common fields work without narrowing)
- `useSelector(role, fn)` — narrows to a specific variant, returns `T | undefined` if the current role doesn't match

## Consequences

### Positive

- Reliable server-side sync eliminates the fragile client-as-broker pattern
- Type-safe via discriminated unions — `LinkedView<T>` auto-derived from the contract's views
- Push-based, not polling — updates arrive when source state changes
- Reuses existing `broadcastViews()` infrastructure — DO subscribers are just another delivery target
- Common fields accessible without narrowing (e.g., `players` across all game views)
- Role changes propagate automatically — source recomputes role on every push, no stale data
- Mixed roles in collections work naturally — each instance resolves independently
- Collections use the same API as single links — no separate concept

### Negative

- Subscription management adds complexity to the runtime (two new SQLite tables, re-registration on restart)
- Staleness window on restart — between wake-up and re-registration, the subscriber may have stale data
- No built-in cycle detection — checksum deduplication dampens cycles but does not prevent infinite loops if two actors mutually update state in a way that always changes the view
- `link()` means two different things in two contexts — `await link()` in init is blocking, `link()` in messages is fire-and-forget (the `await` keyword makes intent clear, accepted trade-off)

### Neutral

- Supersedes the old `emit({ actor, id, message })` pattern for actor-to-actor state sync
- Uses `callerType: "service"` — no new identity concept introduced
- Link data is just state fields, persisted in the normal `snapshots` table
