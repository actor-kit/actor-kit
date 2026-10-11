---
title: Views
description: Schema-defined views with per-role projections.
---

## What is a View?

A view is a projection of the actor's state for a specific role. Different roles can see different data from the same actor.

```typescript
import { view, schema, uint32, string, array } from "@actor-kit/core";

const OwnerView = schema({ todos: array(TodoItem), memberCount: uint32 });
const ViewerView = schema({ todoCount: uint32, doneCount: uint32 });

views: {
  owner: view.shared(OwnerView, (state) => ({
    todos: state.todos,
    memberCount: state.memberIds.length,
  })),
  viewer: view.shared(ViewerView, (state) => ({
    todoCount: state.todos.length,
    doneCount: state.todos.filter(t => t.done).length,
  })),
},
```

## Schema

`schema()` defines the shape of the view for both TypeScript type inference and binary encoding:

```typescript
const PlayerView = schema({
  x: float32,
  y: float32,
  health: uint32,
  name: string,
  alive: boolean,
});

type PlayerViewType = Infer<typeof PlayerView>;
// { x: number; y: number; health: number; name: string; alive: boolean }
```

### Primitives

| Type | Bytes | TypeScript |
|------|-------|------------|
| `uint8` | 1 | `number` |
| `uint16` | 2 | `number` |
| `uint32` | 4 | `number` |
| `int8` / `int16` / `int32` | 1 / 2 / 4 (two's complement) | `number` |
| `float32` | 4 | `number` |
| `float64` | 8 | `number` |
| `string` | 2 + UTF-8 | `string` |
| `boolean` | 1 | `boolean` |

### Combinators

- `array(T)` — array of any schema type
- `nullable(T)` — field that can be `null` (adds a compact null bitmask to the wire format)
- Nested `schema({...})` — objects within objects
- `enumOf(["lobby", "playing"])` — one of a fixed list (strings, numbers or booleans), sent as its index (1 byte up to 256 values); `literal("card")` is a one-value enum that takes no bytes
- `record(T)` — a string-keyed record (`Record<string, T>`); a delta sends only removed, changed and added keys
- `union(tag, { name: schema({...}) })` — a discriminated union `{ [tag]: name, ...fields }`; a delta sends only the changed fields while the variant stays the same, the whole variant when it changes
- `json(zodSchema)` — escape hatch for shapes the binary types cannot express: sent as JSON text, parsed with the Zod schema on the client, resent whole when it changes

```typescript
import { enumOf, int16, json, record, schema, uint8, union } from "@actor-kit/core";
import { z } from "zod";

const PlayerView = schema({
  phase: enumOf(["lobby", "playing", "done"]),
  scores: record(int16), // signed: scores can go negative
  turn: union("kind", {
    waiting: schema({}),
    acting: schema({ player: uint8, seconds: uint8 }),
  }),
  settings: json(z.object({ theme: z.string() })),
});

type PlayerViewType = Infer<typeof PlayerView>;
// {
//   phase: "lobby" | "playing" | "done";
//   scores: Record<string, number>;
//   turn: { kind: "waiting" } | { kind: "acting"; player: number; seconds: number };
//   settings: { theme: string };
// }
```

All of these nest (a record of unions, an array of enums, a nullable union, ...). Encoding a value
outside an enum or an unknown union variant throws; the server never sends a frame the client cannot
decode.

## Binary Sync

Views defined with `view.shared(schema, fn)` or `view.perCaller(schema, fn)` are automatically encoded as compact binary frames with delta encoding — only changed fields are sent. A position update (3 float32 fields) is 15 bytes as a binary delta vs ~100 bytes as JSON.

See [Binary State Sync](/concepts/binary-sync/) for the full wire protocol, frame format, and reconnection details.

## View Computation

Views are computed after every transition. The framework:
1. Calls your view function with the current state and caller
2. Compares with the previous view for this connection
3. If changed: encodes and sends (binary delta or JSON)
4. If unchanged: skips (no frame sent)

This means views are cheap — if nothing changed for a particular caller, nothing is sent.

### Scalability Impact

The choice between `view.shared` and `view.perCaller` directly affects how many clients a single actor can serve. Shared views encode once regardless of connection count; per-caller views encode once per client. See [Scalability](/concepts/scalability/) for fan-out patterns, partitioning strategies, and practical limits.

## Discriminated Union Views (`LinkedView`)

Every view push (to both WebSocket clients and linked actors) includes a `role` field. This produces a TypeScript discriminated union:

```typescript
views: {
  admin:     view.shared(AdminView,     (state) => ({ players: state.players, settings: state.settings })),
  player:    view.perCaller(PlayerView,    (state, caller) => ({ players: state.players, myScore: state.scores[caller] })),
  spectator: view.shared(SpectatorView, (state) => ({ players: state.players })),
}

// LinkedView<GameContract> — auto-derived from the contract:
// | { role: "admin";     players: Player[]; settings: Settings }
// | { role: "player";    players: Player[]; myScore: number }
// | { role: "spectator"; players: Player[] }
```

Use `view.role` to narrow in TypeScript:

```typescript
switch (view.role) {
  case "admin":     /* view.settings is available */ break;
  case "player":    /* view.myScore is available */ break;
  case "spectator": /* only view.players */ break;
}
```

Fields common to all variants (like `players` above) are accessible without narrowing.

### In React

```tsx
// Route by role
const role = useRole();  // "admin" | "player" | "spectator" | undefined

// Select common fields — no narrowing needed
const players = useSelector((view) => view?.players);

// Select role-specific fields — pass role to narrow
const revenue = useSelector("admin", (view) => view.revenue);
// type: number | undefined (undefined if role isn't "admin")
```

### In actor-to-actor links

Same pattern. `onUpdate` receives the discriminated union:

```typescript
links: {
  game: link(GameContract, {
    onUpdate: (state, view, gameId) => {
      // view.players works without narrowing (common field)
      // view.role discriminates for role-specific fields
      return { ...state, games: { ...state.games, [gameId]: view } };
    },
  }),
},
```

See [Actor-to-Actor Communication](/recipes/actor-to-actor/) for the full `link()` API.

## Role Composition

Roles don't "inherit" from each other — there's no role hierarchy in the framework. Instead, compose views by extracting shared projection logic into plain functions and spreading into each role's view.

```typescript
// Extract shared projection for reuse across roles
const baseProjection = (state: GameState) => ({
  players: state.players,
  status: state.status,
  roundNumber: state.roundNumber,
});

views: {
  admin: view.shared(AdminView, (state) => ({
    ...baseProjection(state),
    revenue: state.revenue,
    settings: state.settings,
    reports: state.reports,
  })),
  moderator: view.shared(ModView, (state) => ({
    ...baseProjection(state),
    reports: state.reports,
  })),
  player: view.perCaller(PlayerView, (state, caller) => ({
    ...baseProjection(state),
    myScore: state.scores[caller],
  })),
  spectator: view.shared(SpectatorView, (state) => baseProjection(state)),
}
```

A few things to note:

- **Shared functions, not framework magic.** `baseProjection` is a plain function you write. The framework doesn't know about it — it just calls your view function.
- **Admin is a superset of spectator.** That's a consequence of spreading the same base and adding fields. TypeScript's structural typing means fields common to all views (like `players`, `status`, `roundNumber`) are accessible without narrowing on the discriminated union.
- **Each role still has its own schema.** `AdminView` and `SpectatorView` are separate `schema()` definitions with different binary layouts. The shared projection is a convenience for the _function_, not the _encoding_.
- **Keep projections pure.** View functions run after every transition. Avoid allocations or computation that scales with connection count — the framework already handles per-connection diffing.

## Related

- [Binary State Sync](/concepts/binary-sync/) — deep dive into the binary wire protocol, delta encoding, and frame format
- [Actor-to-Actor Communication](/recipes/actor-to-actor/) — links, services, and DO stubs for actor sync
