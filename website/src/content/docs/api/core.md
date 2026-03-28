---
title: "actor-kit"
description: Server-side API reference.
---

The core package (`import from "actor-kit"`) provides the server-side API. Use in your Cloudflare Worker.

## `defineActor(name, def)`

Creates a typed contract from an actor definition. The contract preserves all type information for downstream consumers.

```typescript
import { z } from "zod";
import { defineActor, message, view, schema, uint32, string } from "actor-kit";

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

export const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: () => ({ count: 0, lastUpdatedBy: null as string | null }),
  roles: { user: () => true },
  messages: {
    INCREMENT: message(z.object({}), (state, _payload, { caller }) => ({
      ...state, count: state.count + 1, lastUpdatedBy: caller,
    })),
  },
  views: { user: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })) },
});
```

**Parameters:**
- `name: string` — actor type name (used in JWT `aud` claim, normalized to UPPER_SNAKE_CASE for env binding)
- `def` — the actor definition object (must have `input` and `init`)

**Returns:** `ActorContract<TName, TDef>` — a typed contract with `{ name, def }`.

## `createActorClass(contract)`

Converts a typed contract into a Durable Object class.

```typescript
export const Counter = createActorClass(CounterContract);
```

Handles both flat messages (v3) and role-nested messages (sequential/parallel states). For flat messages, wraps them so every role has access — guards handle authorization.

**Returns:** A class extending `DurableObject` with `spawn()`, `send()`, `getSnapshot()`, `fetch()`, and `alarm()`.

### Definition fields

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Zod schema for spawn input |
| `init(input)` | Yes | Returns initial state |
| `roles` | Yes | `Record<string, (state, caller, claims) => boolean>` |
| `messages` | Yes* | Flat message handlers (or per-role in `states`) |
| `views` | Yes | Per-role view definitions |
| `version` | No | Number for migration |
| `initial` | No | Initial state name (sequential states) |
| `states` | No | Sequential or parallel state definitions |
| `after` | No | Durable timers (DO Alarms) |
| `tick` | No | Game loop (setInterval) |
| `lifecycle` | No | Connection handlers (`connect`, `disconnect`) |
| `observe` | No | `{ onTransition }` hook |
| `migrate` | No | `(persisted, fromVersion) => newState` |
| `serialize` | No | Custom state serializer |
| `restore` | No | Custom state deserializer |

## `message(zodSchema, handler | { guard, handler })`

Pairs a Zod validation schema with a message handler. Handlers are synchronous.

```typescript
// Simple handler
const increment = message(z.object({}), (state, _payload, { caller }) => ({
  ...state, count: state.count + 1, lastUpdatedBy: caller,
}));

// With guard
const reset = message(z.object({}), {
  guard: (_state, _payload, ctx) => ctx.role === "admin",
  handler: () => ({ count: 0, lastUpdatedBy: null }),
});
```

Guard receives `(state, payload, ctx)` where ctx has `{ role, caller, callerType, env, emit }`.

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

## `createRef(contract, env, id)` / `createRef(env, actorType, actorId)`

Creates a typed reference to another actor for DO-to-DO communication.

```typescript
// Contract-derived — send() typed to contract's messages
const zone = createRef(ZoneContract, env, "forest-north");

// Legacy — untyped send()
const zone = createRef(env, "ZONE", "forest-north");
```

Contract name is normalized to UPPER_SNAKE_CASE for env lookup: `"my-actor"` → `"MY_ACTOR"`.

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

## `encode(schema, data)` / `decode(schema, bytes)`

Binary encoder and decoder for schema-defined data.

```typescript
const bytes = encode(PlayerView, { x: 1.5, y: 2.5, health: 100 });
const data = decode(PlayerView, bytes);
```

## Schema primitives

`uint8`, `uint16`, `uint32`, `float32`, `float64`, `string`, `boolean`, `array(T)`
