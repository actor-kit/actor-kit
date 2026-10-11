---
title: Actor-to-Actor Communication
description: How actors sync state, forward events, and call each other using links, services, and DO stubs.
---

Actors are always separate Durable Objects. They communicate by sending messages, syncing state, or reading snapshots — never by sharing memory. There are three patterns, depending on what you need.

## Links — Sync State from Another Actor

Use `link()` when one actor needs to stay in sync with another actor's view. Links are push-based subscriptions — when the source actor's state changes, the subscriber receives the new view automatically.

### Declare links

```typescript
import { link, setup } from "@actor-kit/worker";

const player = setup({});

const PlayerContract = player.actor("player", {
  input: z.object({ profileId: z.string() }),

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
      onUnlink: (state, gameId) => {
        const { [gameId]: _, ...rest } = state.games;
        return { ...state, games: rest };
      },
    }),
    // **Note:** `onError` and `onUnlink` callbacks are declared in the link
    // definition for future use. Currently, only `onUpdate` is invoked by the
    // runtime. Handle cleanup in your `unlink()` message handler directly.
  },

  init: (input) => ({
    profileId: input.profileId,
    profile: null as LinkedView<ProfileContract> | null,
    games: {},      // linked later via messages
  }),

  messages: {
    SETUP: player.message(z.object({}), {
      guard: (_state: PlayerState, _payload, ctx) => ctx.callerType === "service",
      handler: (state: PlayerState, _payload, { link }) => {
        link("profile", state.profileId);  // view arrives via onUpdate
        return state;
      },
    }),
    JOIN_GAME: player.message(z.object({ gameId: z.string() }), (state: PlayerState, { gameId }, { link }) => {
      link("game", gameId);   // fire-and-forget, view arrives via onUpdate
      return { ...state, gameStatus: "connecting" };
    }),
    LEAVE_GAME: player.message(z.object({ gameId: z.string() }), (state: PlayerState, { gameId }, { unlink }) => {
      unlink("game", gameId);
      return state;
    }),
  },

  views: {
    user: view.shared(PlayerView, (state: PlayerState) => ({
      profileName: state.profile?.name ?? "",
      games: Object.keys(state.games),
    })),
  },
});
```

### How it works

1. `link("profile", id)` in the `SETUP` message handler → subscribes asynchronously. The first view arrives via `onUpdate`. State starts null, becomes non-null on first update.
2. `link("game", gameId)` in a message handler → subscribes asynchronously. Same pattern — the first view arrives via `onUpdate`.
3. When the source actor's state changes → `broadcastViews()` pushes the new view to all subscribers (alongside WebSocket clients). The subscriber's `onUpdate` reducer runs, persisting the new state.
4. On crash/restart → subscriptions are re-registered. If the source changed during downtime, `onUpdate` fires with the current view.

> **Note:** Init-time link resolution (blocking fetch during init) is planned but not yet implemented. For now, use a setup message to establish links after init.

### Discriminated union views

The source actor resolves the subscriber's role on every push — same as for WebSocket clients. The view includes a `role` discriminant, producing a TypeScript discriminated union:

```typescript
// GameContract has these views:
views: {
  admin:     view.shared(AdminView, (state) => ({ players: state.players, settings: state.settings, revenue: state.revenue })),
  player:    view.perCaller(PlayerView, (state, caller) => ({ players: state.players, myScore: state.scores[caller] })),
  spectator: view.shared(SpectatorView, (state) => ({ players: state.players })),
}

// LinkedView<GameContract> is auto-derived:
// | { role: "admin";     players: Player[]; settings: Settings; revenue: number }
// | { role: "player";    players: Player[]; myScore: number }
// | { role: "spectator"; players: Player[] }
```

In `onUpdate`, narrow with `view.role`:

```typescript
onUpdate: (state, view, gameId) => {
  switch (view.role) {
    case "admin":
      // TS narrows: view has settings, revenue
      return { ...state, games: { ...state.games, [gameId]: view } };
    case "player":
      // TS narrows: view has myScore
      return { ...state, games: { ...state.games, [gameId]: view } };
    case "spectator":
      return { ...state, games: { ...state.games, [gameId]: view } };
  }
}
```

Fields common to all variants (like `players` above) are accessible without narrowing.

### Role changes at runtime

If the subscriber's role changes (e.g., promoted from player to admin), the next push arrives with the new role's view. The `switch` on `view.role` handles it naturally — no stale data, no data leaks.

### Collections

Call `link(name, id)` with different IDs. `onUpdate`/`onUnlink` receive the `id` as third arg:

```typescript
link("game", "game-1");   // subscribe to game-1
link("game", "game-2");   // subscribe to game-2
link("game", "game-3");   // subscribe to game-3

unlink("game", "game-2"); // unsubscribe from game-2
unlink("game");            // unsubscribe from all
```

Each target resolves the subscriber's role independently — you can be admin on game-1 and a player on game-2.

## Services — Fire-and-Forget or Async Effects

Use `execute()` with a named service when you need to call an external API, send to a Queue, or write to KV/D1/R2. The service runs asynchronously after the state change commits.

```typescript
const zone = setup({});

zone.actor("zone", {
  services: {
    transferPlayer: {
      fn: async ({ targetZone, playerId, health, inventory }, env) => {
        const stub = env.ZONE.get(env.ZONE.idFromName(targetZone));
        const result = await stub.send("system", "service", {
          type: "PLAYER_ARRIVED",
          playerId, health, inventory,
        });
        // send() resolves to { ok: true } or a refusal { ok: false, code, message, ... }
        if (!result.ok) throw new Error(result.message);
      },
      onDone: (state, result, input) => ({
        ...state,
        transferStatus: "confirmed",
      }),
      onError: (state, error, input) => ({
        ...state,
        transferStatus: "failed",
        error: error._tag,
      }),
    },
  },

  messages: {
    TRANSFER_PLAYER: zone.message(
      z.object({ playerId: z.string(), targetZone: z.string() }),
      (state: ZoneState, { playerId, targetZone }, { execute }) => {
        execute("transferPlayer", {
          targetZone,
          playerId,
          health: state.players[playerId].health,
          inventory: state.players[playerId].inventory,
        });
        const { [playerId]: _, ...remaining } = state.players;
        return { ...state, players: remaining, transferStatus: "pending" };
      },
    ),
  },
});
```

Services are durable — the outbox persists the service name and input atomically with the state change. If the DO crashes, pending services retry on restart.

## Direct RPC with Typed DO Stubs

Use Cloudflare's native typed DO bindings inside your Worker's `fetch` handler (not inside an actor) when you need to interact with actors from request-handling code — spawning, sending messages, or reading snapshots.

Run `npx wrangler types` to generate typed bindings for your `Env`. This gives you `DurableObjectNamespace<ZoneActor>` on `env.ZONE`, with full type safety for `spawn()`, `send()`, and `getSnapshot()`.

```typescript
import type { ZoneActor } from "./zone";

export default {
  async fetch(request: Request, env: Env) {
    const stub = env.ZONE.get(env.ZONE.idFromName("forest-north"));

    await stub.spawn({
      actorId: "forest-north",
      caller: "system",
      callerType: "service",
      input: { biome: "forest" },
    });

    const sent = await stub.send("system", "service", {
      type: "SPAWN_NPC",
      npcType: "merchant",
    });
    if (!sent.ok) return Response.json(sent, { status: 409 }); // a Refusal: code, message, docs

    const { snapshot, role } = await stub.getSnapshot("system", "service");
    return Response.json(snapshot);
  },
};
```

## Which to Use

| Pattern | When | Response? | Delivery | Stays in sync? |
|---------|------|-----------|----------|---------------|
| `link()` | Actor needs another actor's state | Push-based view updates | Durable (outbox + subscription) | Yes |
| `execute()` + service | Actor needs to call an API or notify another actor | `onDone`/`onError` | At-least-once via outbox | No — one-shot |
| DO stub (`env.BINDING.get(...)`) | Worker fetch handler | Direct RPC return | Immediate | No |

**Links** are for ongoing state sync between actors — Player staying in sync with Profile, Game syncing player profiles.

**Services** are for one-shot async effects — calling an API, sending to a Queue, or firing a notification to another actor without staying subscribed.

**DO stubs** are for request-handling code outside actors — spawning actors, sending messages, reading snapshots from a Worker route handler.

## Actor Discovery via `ctx.exports`

When all actors deploy in a single Worker (the recommended pattern), Cloudflare's `ctx.exports` provides automatic namespace discovery — no manual env bindings needed between actors.

### Enable the compat flag

```jsonc
// wrangler.jsonc
{
  "compatibility_flags": ["enable_ctx_exports"]
}
```

### How it works

`createActorClass()` stamps each DO class with its contract name. The framework's `resolveNamespace()` iterates `ctx.exports` to find the matching class:

```typescript
import { createRef } from "@actor-kit/worker";

// Inside a message handler (ctx.exports is NOT available on message ctx):
const ref = createRef(ProfileContract, env, profileId);
await ref.send("system", "service", { type: "UPDATE_NAME", name: "Alice" }); // { ok: true } or a Refusal
```

> **Note:** `ctx.exports`-based resolution happens automatically inside the framework's `link()` and `resolveNamespace()` internals. Message handlers do not have access to `ctx.exports` — use the `createRef(contract, env, actorId)` overload which looks up the env binding directly.

The `createRef(contract, exports, env, actorId)` overload (used internally by the framework):
1. Searches `exports` for a DO class whose contract name matches
2. Falls back to `env.BINDING_NAME` if not found in exports
3. Throws if not found in either

### Fallback: env bindings

For multi-Worker deployments or when `ctx.exports` isn't available, env bindings still work:

```typescript
// Legacy: env binding lookup
const ref = createRef(ProfileContract, env, profileId);
```

You can also use `resolveNamespace()` directly:

```typescript
import { resolveNamespace } from "@actor-kit/worker";

const namespace = resolveNamespace("profile", ctx.exports, env);
```

## Wrangler Bindings

All actors must be declared as Durable Object classes in your `wrangler.jsonc` (required for storage migrations). With `ctx.exports` enabled, the `bindings` array is only needed for cross-Worker actors:

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "ZONE", "class_name": "ZoneActor" },
      { "name": "PLAYER", "class_name": "PlayerActor" },
      { "name": "PROFILE", "class_name": "ProfileActor" }
    ]
  }
}
```

The binding name (e.g., `"ZONE"`) is derived from the actor's contract name: `zone.actor("zone", ...)` → binding `ZONE`. It must match the key in your Worker's `Env` type.

## Related

- [Side Effects](/concepts/side-effects/) — how `execute()` and the transactional outbox work
- [Views](/concepts/views/) — per-role view projections and discriminated union types
- [Testing Side Effects](/recipes/testing-side-effects/) — how to capture and assert `execute()` calls and link subscriptions in tests
