---
title: actor-kit
description: Server-side API reference.
---

The root export (`import from "actor-kit"`) provides the server-side API. Use this in your Cloudflare Worker.

## `actor(name, def)`

Creates a Durable Object class from an actor definition.

```typescript
export const Counter = actor("counter", {
  input: z.object({}),
  init: () => ({ count: 0 }),
  roles: { user: () => true },
  messages: { user: { INCREMENT: increment } },
  views: { user: view(CounterView, (state) => ({ count: state.count })) },
});
```

**Parameters:**
- `name: string` — actor type name (used in JWT `aud` claim)
- `def: ActorDef` — the actor definition object

**Returns:** A class extending `DurableObject` with `spawn()`, `send()`, `getSnapshot()`, `fetch()`, and `alarm()`.

### Definition fields

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Zod schema for spawn input |
| `init(input)` | Yes | Returns initial state |
| `roles` | Yes | `Record<string, (state, caller, claims) => boolean>` |
| `messages` | Yes* | Per-role message handlers |
| `views` | Yes | Per-role view definitions |
| `version` | No | Number for migration |
| `initial` | No | Initial state name (sequential states) |
| `states` | No | Sequential or parallel state definitions |
| `after` | No | Durable timers (DO Alarms) |
| `tick` | No | Game loop (setInterval) |
| `on` | No | Lifecycle handlers + request callbacks |
| `observe` | No | `{ onTransition }` hook |
| `migrate` | No | `(persisted, fromVersion) => newState` |
| `serialize` | No | Custom state serializer |
| `restore` | No | Custom state deserializer |

## `schema(shape)`

Defines a view shape for binary encoding and TypeScript inference.

```typescript
const MyView = schema({ count: uint32, name: string, items: array(ItemSchema) });
type MyViewType = Infer<typeof MyView>;
```

## `view(schema, fn)`

Pairs a schema with a projection function.

```typescript
const ownerView = view(OwnerSchema, (state, caller) => ({ ... }));
```

## `message(zodSchema, handler | { guard, handler })`

Pairs a Zod validation schema with a message handler.

```typescript
const increment = message(z.object({ amount: z.number() }), (state, { amount }) => ...);
const guarded = message(z.object({}), { guard: (s) => !s.closed, handler: (s) => ... });
```

## `createRef(env, actorType, actorId)`

Creates a typed reference to another actor for DO-to-DO communication.

```typescript
const zone = createRef(env, "ZONE", "forest-north");
await zone.send("system", "service", { type: "ACCEPT_TRANSFER", ... });
```

## `createAccessToken(params)`

Creates a JWT for WebSocket authentication. Returns `Promise<string>`.

```typescript
const token = await createAccessToken({
  actorType: "counter",
  actorId: "my-counter",
  callerId: "user-123",
  callerType: "user",
  secret: env.ACTOR_KIT_SECRET,
});
```

| Param | Type | Description |
|-------|------|-------------|
| `actorType` | `string` | Actor type name (JWT `aud` claim) |
| `actorId` | `string` | Actor instance ID (JWT `jti` claim) |
| `callerId` | `string` | Caller identity (JWT `sub` claim) |
| `callerType` | `"user" \| "service"` | Caller type (JWT `act` claim) |
| `secret` | `string` | HS256 signing secret |
| `expiresIn` | `string` | Optional expiry (default: `"1h"`) |

## `getCallerFromToken(token, secret, actorType, actorId)`

Validates a JWT and extracts the caller identity. Returns `Promise<{ caller: string; callerType: "user" | "service" }>`. Throws on invalid/expired tokens or audience/ID mismatch.

## `parseActorRoute(pathname)`

Parses `/api/:actorType/:actorId` from a URL pathname. Returns `{ actorType, actorId }` or `null`.

```typescript
const route = parseActorRoute("/api/counter/my-counter");
// { actorType: "counter", actorId: "my-counter" }
```

## `encode(schema, data)` / `decode(schema, bytes)`

Binary encoder and decoder for schema-defined data. Used internally for binary sync, but exported for custom use.

```typescript
const bytes = encode(PlayerView, { x: 1.5, y: 2.5, health: 100 });
const data = decode(PlayerView, bytes);
```

## Schema primitives

`uint8`, `uint16`, `uint32`, `float32`, `float64`, `string`, `boolean`, `array(T)`
