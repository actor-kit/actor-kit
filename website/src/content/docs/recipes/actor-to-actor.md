---
title: Actor-to-Actor Communication
description: How actors send messages to each other using emit, request, and createRef.
---

Actors are always separate Durable Objects. They communicate by sending messages to each other — never by sharing memory or state. There are three ways to do this, depending on whether you need a response.

## Fire-and-forget with `emit()`

Use `emit()` when you want to notify another actor but don't need a response. The message is recorded in the transactional outbox and delivered asynchronously after the state change commits.

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

## Async with callbacks using `request()`

Use `request()` when you need to know whether a side effect succeeded or failed. Define typed callbacks with `callback()`, then reference them in `request()`. The framework delivers the result to your actor's `callbacks` block.

```typescript
import { callback, message } from "actor-kit";
import { z } from "zod";

const PriceReceived = callback("PRICE_RECEIVED", z.object({ price: z.number() }));
const PriceFailed = callback("PRICE_FAILED", z.object({ message: z.string() }));

const fetchPrice = message(
  z.object({ itemId: z.string() }),
  (state, { itemId }, { request }) => {
    request({
      fetch: `https://api.example.com/prices/${itemId}`,
      onDone: PriceReceived,
      onError: PriceFailed,
    });

    return { ...state, priceStatus: "loading" };
  },
);
```

Handle the callbacks in the `callbacks` block:

```typescript
callbacks: {
  PRICE_RECEIVED: (state, { result }, ctx) => ({
    ...state,
    priceStatus: "loaded",
    price: result.price,
  }),
  PRICE_FAILED: (state, { error }, ctx) => ({
    ...state,
    priceStatus: "failed",
    error: error.message,
  }),
},
```

For actor-to-actor effects, `request()` with `onDone` confirms that the message was delivered successfully, but `onDone` receives an empty object (not the target actor's state). Use `emit()` for fire-and-forget actor messages unless you need delivery confirmation.

## Direct RPC with `createRef()`

Use `createRef()` inside your Worker's `fetch` handler (not inside an actor) when you need to interact with actors from request-handling code — spawning, sending messages, or reading snapshots.

```typescript
import { createRef } from "actor-kit";

export default {
  async fetch(request: Request, env: Env) {
    const zone = createRef(env, "ZONE", "forest-north");

    // Spawn the actor if it doesn't exist
    await zone.spawn({
      actorId: "forest-north",
      caller: "system",
      callerType: "service",
      input: { biome: "forest" },
    });

    // Send a message
    await zone.send("system", "service", {
      type: "SPAWN_NPC",
      npcType: "merchant",
    });

    // Read its current state
    const { snapshot, role } = await zone.getSnapshot("system", "service");

    return Response.json(snapshot);
  },
};
```

`createRef()` creates a typed stub backed by the Durable Object namespace from your Worker env bindings.

## Which to use

| Method | Where | Response? | Delivery |
|--------|-------|-----------|----------|
| `emit({ actor })` | Inside a message handler | No | At-least-once via outbox |
| `request({ actor })` | Inside a message handler | Yes (onDone/onError) | At-least-once via outbox |
| `createRef()` | Worker fetch handler | Direct RPC return | Immediate |

**Inside actors**, prefer `emit()` or `request()` — they participate in the transactional outbox, so if the DO crashes after the state change commits, pending messages will be retried on restart.

**Outside actors** (Worker fetch handler, scheduled handler), use `createRef()` for direct RPC.

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

The binding name (e.g. `"ZONE"`) is what you pass as the `actor` field in `emit()` / `request()` and as the `actorType` in `createRef()`. It must match the key in your Worker's `Env` type.
