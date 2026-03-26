---
title: "@actor-kit/core & @actor-kit/worker"
description: Server-side API reference.
---

The server-side API is split across two packages: `@actor-kit/core` (schema, view, types) and `@actor-kit/worker` (actor, message, callback, auth helpers). Use these in your Cloudflare Worker.

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
| `lifecycle` | No | Connection handlers (`connect`, `disconnect`) |
| `callbacks` | No | Request callback handlers (from `request()`) |
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

## `callback(name, resultSchema)` / `callback(name, resultSchema, metaSchema)`

Creates a typed callback definition for use with `request()`. Pairs a callback name with Zod schemas for the result and optional per-request meta.

```typescript
import { callback } from "@actor-kit/worker";

// Without meta
const PriceReceived = callback("PRICE_RECEIVED", z.object({ total: z.number() }));
const PriceFailed = callback("PRICE_FAILED", z.object({ message: z.string() }));

// With meta (per-request context passed through to the handler)
const PriceReceived = callback(
  "PRICE_RECEIVED",
  z.object({ total: z.number() }),
  z.object({ itemId: z.string() }),
);
```

Use callback definitions as `onDone`/`onError` in `request()`, and handle them in the actor's `callbacks` block:

```typescript
// In a message handler:
request({ fetch: url, onDone: PriceReceived, onError: PriceFailed, meta: { itemId } });

// In the actor definition:
callbacks: {
  PRICE_RECEIVED: (state, { result, meta }, ctx) => ({ ...state, price: result.total }),
  PRICE_FAILED: (state, { error }, ctx) => ({ ...state, error: error.message }),
},
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
| `expiresIn` | `string` | Optional expiry (default: `"30d"`) |

## `getCallerFromToken(token, actorType, actorId, secret)`

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
