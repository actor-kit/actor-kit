# Spec: Message Forwarding on Links

**Date**: 2026-04-05
**Status**: Draft
**Depends on**: ADR-011 (links)

## Problem

When Actor A links to Actor B, it often needs to forward incoming messages to B. Currently this requires a service + handler per forwarded message — verbose and doesn't scale.

Real-world example: Player actor receives MINIGAME_COMPLETED from the client and needs to forward it to the Profile actor.

## Design: `forward` on links

### Declarative forwarding

```typescript
const PlayerContract = defineActor("player", {
  input: z.object({ profileId: z.string() }),

  links: {
    profile: link(ProfileContract, {
      forward: ["MINIGAME_COMPLETED", "LEVEL_UP", "PURCHASE_ITEM"],
      onUpdate: (state, view) => ({ ...state, profile: view }),
    }),
  },

  messages: {
    // This handler runs locally AND the message is forwarded to Profile
    MINIGAME_COMPLETED: message(z.object({ score: z.number() }), (state, { score }) => ({
      ...state,
      lastScore: score,
    })),

    // This message has no local handler — it's forwarded-only
    // LEVEL_UP is in the forward list but not in messages — framework forwards it directly

    // This message is NOT forwarded — only handled locally
    SET_NAME: message(z.object({ name: z.string() }), (state, { name }) => ({
      ...state,
      name,
    })),
  },
});
```

### Behavior

When a message arrives at the Player actor:
1. Framework checks if the message type is in any link's `forward` list
2. If yes: **queue a forward** to the linked actor(s) via outbox
3. Also run the local handler if one exists (handler is optional for forwarded messages)
4. Forward happens asynchronously after the handler, same as execute()

### Forward targets

If the link has multiple active instances (collection), forwarding sends to ALL linked instances:

```typescript
links: {
  games: link(GameContract, {
    forward: ["HEARTBEAT"],  // forward to ALL linked games
    onUpdate: (state, view, gameId) => ({ ... }),
  }),
},
```

Or forward to a specific instance using a resolver:

```typescript
links: {
  games: link(GameContract, {
    forward: {
      HEARTBEAT: "*",                          // all linked instances
      GAME_ACTION: (payload) => payload.gameId, // specific instance by payload field
    },
    onUpdate: (state, view, gameId) => ({ ... }),
  }),
},
```

### Proxy mode

For relay/proxy actors that should forward everything the target accepts:

```typescript
links: {
  source: link(GameContract, {
    proxy: true,  // forward ALL messages that GameContract accepts
    onUpdate: (state, view) => ({ ...state, currentView: view }),
  }),
},
```

Any message the relay receives that matches a message type on GameContract is automatically forwarded. Messages NOT on GameContract are handled locally only.

### Type safety

`forward` array is constrained to message types that exist on the target contract:

```typescript
// Only messages that ProfileContract.def.messages accepts
forward: ["MINIGAME_COMPLETED"]  // ✓ exists on ProfileContract
forward: ["INCREMENT"]            // ✗ compile error — not a ProfileContract message
```

For `proxy: true`, the relay actor's message types automatically include the target contract's messages. TypeScript union: `PlayerMessages | ProfileMessages`.

### Execution model

1. Message arrives at Player actor
2. Role resolution + guard check (as usual)
3. Local handler runs (if exists) — returns new state
4. Framework checks forward list — if message type matches:
   a. Creates outbox entry: `{ type: "forward", target: "PROFILE", targetId: "alice", message: { type: "MINIGAME_COMPLETED", score: 42 } }`
   b. Persists atomically with state change
5. After commit: drain outbox, send via RPC to target actor's `send()` method
6. If forward fails: no retry (same as current execute behavior). Message is marked failed in outbox.

### Caller identity on forwarded messages

Forwarded messages arrive at the target with `callerType: "service"` and `caller: "player:<do-id>"`. The target's role resolution treats it as a service call.

## Comparison to XState compose

| XState compose | Actor-kit forward |
|---|---|
| Child states inline in parent | Child is a separate DO via link() |
| `uploader.cancelUpload` namespaced event | `forward: ["CANCEL_UPLOAD"]` on link |
| `onDone` when child completes | `onUpdate` when linked view changes |
| Isolated context | Fully isolated (separate DO) |
| Same process, synchronous | Cross-DO RPC via outbox, async |
| Sub-machine imported and inlined | Contract referenced, behavior stays remote |

## Open questions

1. Should forwarded messages include the original caller identity? (For audit: "alice triggered this via Player")
2. Should `proxy: true` exclude messages the proxy actor handles locally? (local handler takes priority)
3. Can you forward to multiple links from one message? (fan-out)
4. Should the forward resolver have access to state? `(state, payload) => targetId`
5. How does this interact with guards? Does the source actor's guard or the target's guard (or both) apply?
