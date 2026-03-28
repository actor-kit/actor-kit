---
title: Actor-to-Actor Communication
description: How actors send messages to each other using emit and native DO stubs.
---

Actors are always separate Durable Objects. They communicate by sending messages to each other — never by sharing memory or state. There are two ways to do this, depending on context.

## Fire-and-forget with `emit()`

Use `emit()` inside message handlers when you want to notify another actor but don't need a response. The message is recorded in the transactional outbox and delivered asynchronously after the state change commits.

```typescript
const transferPlayer = message(
  z.object({ playerId: z.string(), targetZone: z.string() }),
  (state, { playerId, targetZone }, { emit }) => {
    emit({
      actor: "ZONE",
      id: targetZone,
      message: "PLAYER_ARRIVED",
      payload: {
        playerId,
        health: state.players[playerId].health,
        inventory: state.players[playerId].inventory,
      },
    });

    const { [playerId]: _, ...remaining } = state.players;
    return { ...state, players: remaining };
  },
);
```

The source actor removes the player from its state immediately. The target actor receives `PLAYER_ARRIVED` and adds the player. If the target actor is offline, the outbox retries delivery.

### Results come back as messages

When external I/O needs to inform state, the pattern is: emit an intent to a Queue, then the Queue consumer sends the result back as a normal message:

```typescript
messages: {
  FETCH_PRICE: message(z.object({ itemId: z.string() }), (state, { itemId }, { emit }) => {
    emit({ queue: "EFFECTS", body: { type: "FETCH_PRICE", itemId } });
    return { ...state, status: "loading" };
  }),

  // Result comes back as a message from the Queue consumer
  PRICE_RESULT: message(z.object({ itemId: z.string(), total: z.number() }), (state, { itemId, total }) => ({
    ...state,
    prices: { ...state.prices, [itemId]: total },
    status: "loaded",
  })),
},
```

## Direct RPC with typed DO stubs

Use Cloudflare's native typed DO bindings inside your Worker's `fetch` handler (not inside an actor) when you need to interact with actors from request-handling code — spawning, sending messages, or reading snapshots.

Run `npx wrangler types` to generate typed bindings for your `Env`. This gives you `DurableObjectNamespace<ZoneActor>` on `env.ZONE`, with full type safety for `spawn()`, `send()`, and `getSnapshot()`.

```typescript
import type { ZoneActor } from "./zone";

export default {
  async fetch(request: Request, env: Env) {
    // Use wrangler types to get typed bindings: DurableObjectNamespace<ZoneActor>
    const stub = env.ZONE.get(env.ZONE.idFromName("forest-north"));

    // Spawn the actor if it doesn't exist
    await stub.spawn({
      actorId: "forest-north",
      caller: "system",
      callerType: "service",
      input: { biome: "forest" },
    });

    // Send a typed message
    await stub.send("system", "service", {
      type: "SPAWN_NPC",
      npcType: "merchant",
    });

    // Read its current state
    const { snapshot, role } = await stub.getSnapshot("system", "service");

    return Response.json(snapshot);
  },
};
```

`wrangler types` generates an `Env` interface with typed DO namespace bindings derived from your `wrangler.jsonc`. The binding name (e.g., `"ZONE"`) must match the key in your `Env` type.

## Which to use

| Method | Where | Response? | Delivery |
|--------|-------|-----------|----------|
| `emit({ actor })` | Inside a message handler | No | At-least-once via outbox |
| DO stub (`env.BINDING.get(...)`) | Worker fetch handler | Direct RPC return | Immediate |

**Inside actors**, use `emit()` — it participates in the transactional outbox, so if the DO crashes after the state change commits, pending messages will be retried on restart.

**Outside actors** (Worker fetch handler, scheduled handler), use typed DO stubs directly via `env.BINDING.get()`.

## Wrangler bindings

Both actors must be declared as Durable Object bindings in your `wrangler.jsonc`:

```json
{
  "durable_objects": {
    "bindings": [
      { "name": "ZONE", "class_name": "ZoneActor" },
      { "name": "PLAYER", "class_name": "PlayerActor" }
    ]
  }
}
```

The binding name (e.g. `"ZONE"`) is what you pass as the `actor` field in `emit()` and what you use as the key on `env` for direct DO stubs. It must match the key in your Worker's `Env` type.
