# Spec: links — Actor-to-Actor State Sync

**Date**: 2026-03-30
**Status**: Draft (v3 — no role in declaration, discriminated union views)
**Depends on**: ADR-010 (services + execute)

## Problem

Actors need to read and stay in sync with other actors' state. Today this requires the client to broker communication (remix-workers-app pattern: Player DO ←WS→ Client XState ←WS→ Profile DO). If the client disconnects mid-flow, state sync is lost.

Real-world patterns from existing apps:
1. **Static dependency** — Player always needs Profile data from birth (profileId in input)
2. **Dynamic dependency** — Player joins a Game mid-lifecycle (gameId comes from a message)
3. **Collection** — Game needs N player profiles (players join and leave)
4. **Mixed roles** — Player is admin for some games, regular player for others

## Design: `link()` — One Concept

A **link** is a push-based subscription to another actor's view. You declare what you CAN link to, then connect/disconnect at runtime via `ctx.link()` / `ctx.unlink()`.

**No role in the declaration.** The target actor resolves the subscriber's role on every push, just like it does for WebSocket clients. The subscriber receives a **discriminated union** of all possible views, with `role` as the discriminant.

### LinkedView — Discriminated Union

Every actor contract produces a discriminated union type from its views:

```typescript
// GameContract has these views:
views: {
  admin:     view(AdminView,     (state) => ({ players, settings, revenue })),
  player:    view(PlayerView,    (state) => ({ players, myScore })),
  spectator: view(SpectatorView, (state) => ({ players })),
}

// Framework auto-derives:
type LinkedView<typeof GameContract> =
  | { role: "admin";     players: Player[]; settings: Settings; revenue: number }
  | { role: "player";    players: Player[]; myScore: number }
  | { role: "spectator"; players: Player[] }
```

The `role` field is added by the framework to every view push (both WebSocket and DO-to-DO). It's the discriminant for TypeScript narrowing.

**Fields common to all variants are accessible without narrowing:**
```typescript
// `players` exists on ALL variants:
const players = useSelector((view) => view?.players);  // Player[] | undefined — just works

// `revenue` only on admin:
const revenue = useSelector((view) => view?.revenue);  // Error — narrow first
```

### Declaration

```typescript
import { link } from "@actor-kit/worker";

defineActor("player", {
  input: z.object({ profileId: z.string() }),

  links: {
    profile: link(ProfileContract, {
      onUpdate: (state, view) => ({ ...state, profile: view }),
      onError: (state, error) => ({ ...state, profileError: error.message }),
    }),
    game: link(GameContract, {
      onUpdate: (state, view, gameId) => {
        switch (view.role) {
          case "admin":
            return { ...state, games: { ...state.games, [gameId]: view } };
          case "player":
            return { ...state, games: { ...state.games, [gameId]: view } };
          case "spectator":
            return { ...state, games: { ...state.games, [gameId]: view } };
        }
      },
      onError: (state, error, gameId) => ({ ...state, gameErrors: { ...state.gameErrors, [gameId]: error.message } }),
      onUnlink: (state, gameId) => {
        const { [gameId]: _, ...rest } = state.games;
        return { ...state, games: rest };
      },
    }),
  },
  // ...
});
```

`link(contract, handlers)`:
- `contract` — the target actor's contract (from `defineActor()`). Provides type information and the env binding name (derived from `contract.name.toUpperCase()`).
- `handlers`:
  - `onUpdate(state, view, id?)` — view is `LinkedView<TContract>` (discriminated union). `id` present for collections.
  - `onError(state, error, id?)` — source unreachable, destroyed, or revoked access. `error.code`: `"not_found" | "unauthorized" | "unreachable"`.
  - `onUnlink(state, id?)` — cleanup when the source is explicitly unlinked or destroyed.

### Connecting in init (non-nullable)

`init` receives `{ link }` as third arg. `await link(name, id)` fetches the view and subscribes. Returns the typed view (discriminated union). Non-nullable because init blocks until resolved. If the fetch fails, init throws — actor never initializes.

```typescript
init: async (input, env, { link }) => {
  const profile = await link("profile", input.profileId);
  // type: LinkedView<ProfileContract>
  // = { role: "self"; name; email; settings } | { role: "actor"; name; level; coins } | ...
  // non-nullable — guaranteed by await

  return {
    profileId: input.profileId,
    profile,
    game: null as LinkedView<typeof GameContract> | null,
    gameStatus: "disconnected",
  };
},
```

### Connecting in messages (nullable)

Message handlers get `link` and `unlink` on ctx. `link()` is fire-and-forget — subscribes to the target, first view arrives async via `onUpdate`.

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
},
```

### Collections

Same API. Call `link(name, id)` with different IDs. Handlers receive `id` as third arg.

```typescript
defineActor("game", {
  links: {
    players: link(ProfileContract, {
      onUpdate: (state, view, playerId) => ({
        ...state,
        profiles: { ...state.profiles, [playerId]: view },
      }),
      onUnlink: (state, playerId) => {
        const { [playerId]: _, ...rest } = state.profiles;
        return { ...state, profiles: rest };
      },
    }),
  },

  init: () => ({
    profiles: {} as Record<string, LinkedView<typeof ProfileContract>>,
  }),

  messages: {
    PLAYER_JOINED: message(z.object({ playerId: z.string() }), (state, { playerId }, { link }) => {
      link("players", playerId);
      return state;
    }),
    PLAYER_LEFT: message(z.object({ playerId: z.string() }), (state, { playerId }, { unlink }) => {
      unlink("players", playerId);
      return state;
    }),
  },
});
```

`unlink("players", "alice")` — removes one. `unlink("players")` — removes all.

### Mixed roles in collections

Because role is resolved per-instance by the target, different games can return different views:

```typescript
// Player links to 3 games:
link("game", "game-1");  // Game resolves → admin → { role: "admin", players, settings, revenue }
link("game", "game-2");  // Game resolves → player → { role: "player", players, myScore }
link("game", "game-3");  // Game resolves → spectator → { role: "spectator", players }

// All handled by one onUpdate:
onUpdate: (state, view, gameId) => {
  // view: LinkedView<GameContract> — each instance has its own role
  return { ...state, games: { ...state.games, [gameId]: view } };
}
```

### Role changes at runtime

Roles are recomputed on every push. If a player gets demoted from admin:

```
1. Player is admin on game-1          → onUpdate: { role: "admin", revenue: 100, ... }
2. Game demotes player                → broadcastViews recomputes role
3. Next push                          → onUpdate: { role: "player", myScore: 42, ... }
4. switch(view.role) takes new branch → state updates correctly
```

No stale roles. No data leaks. The discriminant changes, the handler adapts.

## React Integration

The same discriminated union pattern extends to React clients.

### `useView()` — Full union

```tsx
function GameUI() {
  const view = useView();
  // type: LinkedView<GameContract> | undefined

  if (!view) return <Loading />;

  switch (view.role) {
    case "admin": return <AdminDashboard game={view} />;
    case "player": return <PlayerHUD game={view} />;
    case "spectator": return <SpectatorView game={view} />;
  }
}
```

### `useRole()` — Just the discriminant

```tsx
const role = useRole();  // "admin" | "player" | "spectator" | undefined
```

### `useSelector()` — With optional role narrowing

```typescript
// Common fields — no narrowing needed (players exists on all variants)
const players = useSelector((view) => view?.players);
// type: Player[] | undefined

// Role-specific fields — pass role as first arg to narrow
const revenue = useSelector("admin", (view) => view.revenue);
// type: number | undefined (undefined if current role isn't "admin")

const myScore = useSelector("player", (view) => view.myScore);
// type: number | undefined
```

Overload signatures:
```typescript
// Full union
useSelector<T>(selector: (view: LinkedView<TContract> | undefined) => T): T;

// Role-narrowed — returns undefined if role doesn't match
useSelector<R extends LinkedView<TContract>["role"], T>(
  role: R,
  selector: (view: Extract<LinkedView<TContract>, { role: R }>) => T,
): T | undefined;
```

## Type Safety

```
link(GameContract, { onUpdate })
  │
  ├── contract.name = "game" → env binding = "GAME"
  │
  ├── contract.def.views
  │    ├── admin:     { schema: AdminView }     → Infer<AdminView>
  │    ├── player:    { schema: PlayerView }    → Infer<PlayerView>
  │    └── spectator: { schema: SpectatorView } → Infer<SpectatorView>
  │
  ├── LinkedView<GameContract> =
  │    | { role: "admin" }     & Infer<AdminView>
  │    | { role: "player" }    & Infer<PlayerView>
  │    | { role: "spectator" } & Infer<SpectatorView>
  │
  ├── onUpdate(state, view: LinkedView<GameContract>, id?) — discriminated union
  ├── await link("game", id) returns LinkedView<GameContract>
  ├── view.role narrows per branch
  ├── view.players works without narrowing (common to all variants)
  └── view.revenue requires narrowing to "admin"
```

Compile errors propagate: if GameContract adds a field to AdminView, dependent actors get errors if they don't handle it. If a view is removed, link consumers get errors.

### `ctx.link` is generic over declared link names

```typescript
// ctx.link is NOT link(name: string, id: string)
// It's generic:
ctx.link<K extends keyof Links>(name: K, id: string): void
ctx.link<K extends keyof Links>(name: K, id: string): Promise<LinkedView<Links[K]>>  // in init

// So:
link("profile", id);   // ✓ — "profile" is a declared link
link("typo", id);       // ✗ — compile error
```

## Ctx Surface

```typescript
// In init:
{ link }: {
  link: <K extends keyof Links>(name: K, id: string) => Promise<LinkedView<Links[K]["contract"]>>
}

// In message handlers:
ctx: {
  caller, callerType, role, env,
  emit,                                   // legacy effects (outbox)
  execute,                                // services (outbox)
  link: <K extends keyof Links>(name: K, id: string) => void,
  unlink: <K extends keyof Links>(name: K, id?: string) => void,
}
```

## Framework Execution Model

### Source actor side

When a source actor's state changes, `broadcastViews()` sends to both WebSocket clients and DO subscribers:
- WebSocket clients: `ws.send(frame)` — synchronous, local
- DO subscribers: outbox entry `{ type: "link_push", subscriber_type, subscriber_id, view, version }` — async, durable

The source **recomputes the subscriber's role on every push** (same as WebSocket clients). No persisted role. If the subscriber's role changes (e.g., admin → player), the new view reflects that.

Outbox entries are persisted atomically with the state change. Drained async after commit. Retried on crash.

Existing deduplication in `broadcastViews()` naturally dampens cycles: if the view hasn't changed (same checksum), the push is skipped.

### Subscriber actor side

When a link update arrives via RPC:
1. Look up the link handler (`onUpdate`)
2. Check monotonic version: skip if `version <= lastSeenVersion`
3. Run `onUpdate(currentState, newView, id)` — pure reducer, view includes `role` discriminant
4. Persist new state
5. Broadcast own views to own WebSocket clients (and own DO subscribers)

### Persistence

**Link data** — just state fields. Persisted in `snapshots` table as normal state JSON.

**Active links** — metadata in a new table, keyed by target actor (not link name):
```sql
CREATE TABLE IF NOT EXISTS active_links (
  target_type TEXT,     -- "PROFILE" or "GAME"
  target_id TEXT,       -- "alice" or "game-123"
  link_name TEXT,       -- "profile" or "game" (local handler routing)
  version INTEGER DEFAULT 0,
  created_at INTEGER,
  PRIMARY KEY (target_type, target_id, link_name)
);
```

Durable identity is `(target_type, target_id)` — not the local link name. Renaming `"profile"` to `"userProfile"` in code requires a migration of `link_name` only (handler routing), not the subscription itself.

On restart: read `active_links` → re-register subscriptions on target actors → receive fresh views → `onUpdate` fires for each that changed.

### Source actor subscriber tracking

```sql
CREATE TABLE IF NOT EXISTS link_subscribers (
  subscriber_type TEXT,  -- "PLAYER"
  subscriber_id TEXT,    -- DO id
  subscribed_at INTEGER,
  PRIMARY KEY (subscriber_type, subscriber_id)
);
```

No role or link name stored on the source. The source just knows "PLAYER:alice is subscribed." On every state change, it recomputes the subscriber's role, computes the view, deduplicates, and pushes.

## Caller Identity for Links

Links use `callerType: "service"` — an actor reading another actor IS a service call. No new callerType needed. The `caller` string encodes the subscriber: `"player:<do-id>"`.

## Addressing Codex Review Findings

| Finding | Resolution |
|---------|------------|
| [P1] `ctx.link` typing is a lie | `ctx.link` is generic over `keyof Links`. `link("typo")` is a compile error. |
| [P1] Persisted roles go stale | No role stored. Source recomputes role on every push, same as WebSocket clients. |
| [P1] `link()` means two things | Accepted trade-off. `await link()` in init = blocking. `link()` in message = async. The `await` makes intent clear. |
| [P1] No producer death signal | `onError(state, error, id?)` fires when source is unreachable, destroyed, or revokes access. |
| [P2] Link names as durable IDs | `active_links` keyed by `(target_type, target_id, link_name)`. Subscription identity is the target, not the local name. |
| [P2] Collections can't vary roles | No role in declaration. Target resolves role per-instance. Admin for game-1, player for game-2 — handled naturally. |

## Open Questions

1. Should `onUpdate` have access to `execute()`? (enables: profile levels up → player triggers unlock service)
2. Should `onUpdate` receive `prevView` for diffing?
3. Should there be a `maxLinks` per name to prevent unbounded collections?
4. Rolling deploy compatibility: source and subscriber on different schema versions?
5. Backpressure: what if a subscriber is slow to process updates?
