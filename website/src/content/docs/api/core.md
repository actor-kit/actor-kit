---
title: "@actor-kit/core & @actor-kit/worker"
description: Server-side API reference.
---

The server-side API is split across two packages: `@actor-kit/core` (schema, view, type primitives) and `@actor-kit/worker` (defineActor, createActorClass, message, identity). Use both in your Cloudflare Worker.

## `defineActor(name, def)`

Creates a typed contract from an actor definition. The contract preserves all type information for downstream consumers.

```typescript
import { z } from "zod";
import { schema, view, uint32, string } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker";

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
  views: { user: view.shared(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })) },
});
export type CounterContract = typeof CounterContract;
```

**Parameters:**
- `name: string` — actor type name (normalized to UPPER_SNAKE_CASE for env binding lookup)
- `def` — the actor definition object (must have `input` and `init`)

**Returns:** `ActorContract<TName, TDef>` — a typed contract with `{ name, def }`.

## `createActorClass(contract)`

Converts a typed contract into a Durable Object class.

```typescript
export const Counter = createActorClass(CounterContract);
```

For flat messages, wraps them so every role has access — guards handle authorization.

**Returns:** A class extending `DurableObject` with `spawn()`, `send()`, `getSnapshot()`, and `fetch()`.

### Definition fields

| Field | Required | Description |
|-------|----------|-------------|
| `input` | Yes | Zod schema for spawn input |
| `init(input)` | Yes | Returns initial state |
| `roles` | Yes | `Record<string, (state, caller, claims) => boolean>` |
| `messages` | Yes | Flat message handlers |
| `views` | Yes | Per-role view definitions |
| `version` | No | Number for migration |
| `lifecycle` | No | Connection handlers (`connect`, `disconnect`) |
| `env` | No | Zod object of the Worker bindings the actor uses (`service<T>()`, `durableObject<T>()`, `queue<T>()`, `kv()`, `r2()`, `d1()`, or any schema). Parsed once; a mismatch refuses every request with a 500 naming each binding |
| `services` | No | Async work run through the outbox: `{ fn(input, env, effect), errors?, retry?, timeoutMs?, onDone?, onError? }` per name. `effect` is `{ actorType, actorId, effectId, idempotencyKey, attempt, signal }`; `onError` gets a typed error. See [Side Effects](/concepts/side-effects/) |
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

Guard receives `(state, payload, ctx)` where ctx has `{ role, caller, callerType, env }`.

## `fail(error)`

Throw from a service's `fn` to fail with a declared, typed error (ADR-016):

```typescript
throw fail({ _tag: "CardDeclined", reason: "insufficient funds" });
```

The runtime parses the value against the service's `errors` schema (a `z.discriminatedUnion("_tag", ...)`); a value that doesn't parse, or anything else thrown, becomes `{ _tag: "Defect", message }`. Declared errors are not retried unless the service's `retry.while(error)` returns true; `Timeout` and `Defect` are.

## `schema(shape)`

Defines a view shape for binary encoding and TypeScript inference.

```typescript
const MyView = schema({ count: uint32, name: string, items: array(ItemSchema) });
type MyViewType = Infer<typeof MyView>;
```

## `view.shared(schema, fn)` / `view.perCaller(schema, fn)`

Pairs a schema with a projection function. Use `view.shared` when the projection does not depend on the caller, and `view.perCaller` when it does.

```typescript
const ownerView = view.shared(OwnerSchema, (state) => ({ ... }));
const playerView = view.perCaller(PlayerSchema, (state, caller) => ({ ... }));
```

## `withCallerIdentity(request, identity)`

Stamps a verified caller identity onto a request for Worker→DO forwarding. This is the primary auth mechanism.

```typescript
import { withCallerIdentity } from "@actor-kit/worker";

const stamped = withCallerIdentity(request, {
  callerId: "user-123",
  callerType: "user",
});
return stub.fetch(stamped);
```

| Param | Type | Description |
|-------|------|-------------|
| `request` | `Request` | The incoming request to stamp |
| `identity.callerId` | `string` | Verified caller identity |
| `identity.callerType` | `"user" \| "service"` | Caller type |

**Security:** Scrubs any existing `X-Actor-Kit-Caller-Id` / `X-Actor-Kit-Caller-Type` headers before setting verified values. Always use this instead of forwarding raw client requests.

**Returns:** A new `Request` with identity headers set. The original request's body stream is transferred (standard fetch spec behavior).

## `parseActorRoute(pathname)`

Parses `/api/:actorType/:actorId` from a URL pathname. Returns `{ actorType, actorId }` or `null`.

## `encode(schema, data)` / `decode(schema, bytes)`

Binary encoder and decoder for schema-defined data.

```typescript
const bytes = encode(PlayerView, { x: 1.5, y: 2.5, health: 100 });
const data = decode(PlayerView, bytes);
```

## Schema primitives

`uint8`, `uint16`, `uint32`, `int8`, `int16`, `int32`, `float32`, `float64`, `string`, `boolean`.

## Schema combinators

`array(T)`, `nullable(T)`, nested `schema({...})`, `enumOf([...values])`, `literal(value)`, `record(T)`,
`union(tag, { variant: schema({...}) })` and `json(zodSchema)`. Every one is inferred by `Infer<>`.
See [Views](/concepts/views/#combinators) for examples and
[the wire protocol](https://github.com/actor-kit/actor-kit/blob/main/docs/binary-protocol.md) for their layout.
