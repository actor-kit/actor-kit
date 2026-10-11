---
title: "@actor-kit/core & @actor-kit/worker"
description: Server-side API reference.
---

The server-side API is split across two packages: `@actor-kit/core` (schema, view, type primitives, errors) and `@actor-kit/worker` (setup, createActorClass, identity). Use both in your Cloudflare Worker.

## `setup(declarations)`

Declares what an actor has up front and returns its **kit**: `setup({ events?, states?, env? })`, every field optional. `setup({})` is the kit of an actor with none of them.

```typescript
import { z } from "zod";
import { queue, setup } from "@actor-kit/worker";

const quiz = setup({
  env: z.object({ QUIZ_EVENTS: queue() }),                     // ctx.env, typed everywhere
  events: { RoundStarted: z.object({ n: z.number() }) },        // ctx.emit, typed
  states: { lobby: {}, round: { local: RoundLocal, input: z.object({ n: z.number() }) } },
});
```

| Field | Description |
|-------|-------------|
| `events` | Domain events: a Zod schema per event name. `ctx.emit` is typed by them. See [Domain Events](/concepts/domain-events/) |
| `states` | Each state's optional `local` and `enter` `input` schemas. See [States](/concepts/states/) |
| `env` | Zod object of the Worker bindings the actor uses (`service<T>()`, `durableObject<T>()`, `queue<T>()`, `kv()`, `r2()`, `d1()`, or any schema). Parsed once; a mismatch refuses every request with a 500 naming each binding |

The kit's helpers:

- **`kit.message(schema, handler | { guard, handler })`** and **`kit.timer(schema, handler)`** — messages and timers whose `ctx.env` and `ctx.emit` are typed by the declarations.
- **`kit.in(state)`** — `.message()`, `.timer()` and `.state({ enter?, messages?, timers? })` for one declared state; their `ctx` adds a typed `phase`, `local`, `stay` and `goto`.
- **`kit.actor(name, def)`** — defines the actor (below).

## `kit.actor(name, def)`

Creates a typed contract from an actor definition. The kit supplies the events, env and state declarations, so the definition holds only behaviour (it never repeats `events` or `env`). The contract preserves all type information for downstream consumers. `defineActor(name, kit, def)` is the same call.

```typescript
import { z } from "zod";
import { schema, view, uint32, string } from "@actor-kit/core";
import { setup } from "@actor-kit/worker";

type CounterState = { count: number; lastUpdatedBy: string };

const CounterView = schema({ count: uint32, lastUpdatedBy: string });
const counter = setup({});

export const CounterContract = counter.actor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: "" }),
  roles: { user: () => true },
  messages: {
    INCREMENT: counter.message(z.object({}), (state: CounterState, _payload, { caller }) => ({
      ...state, count: state.count + 1, lastUpdatedBy: caller,
    })),
  },
  views: { user: view.shared(CounterView, (state: CounterState) => state) },
});
export type CounterContract = typeof CounterContract;
```

**Parameters:**
- `name: string` — actor type name (normalized to UPPER_SNAKE_CASE for env binding lookup)
- `def` — the actor definition object (must have `input` and `init`). With declared states it must name `initial` among them and define every one in `states`; without, it has neither.

**Returns:** `ActorContract<TName, TDef>` — a typed contract with `{ name, def }` (`def` includes the kit's `events` and `env`).

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
| `messages` | Yes | Flat message handlers (`kit.message(...)`); in an actor with states, accepted in every state |
| `views` | Yes | Per-role view definitions |
| `initial` / `states` | With declared states | The first state, and each declared state's definition (`kit.in(name).state({ enter?, messages?, timers? })`) |
| `timers` | No | Declared timers (`kit.timer(...)`). See [Timers](/concepts/timers/) |
| `publish` | No | `{ queue, events }`: send emitted events to a Queue binding. See [Domain Events](/concepts/domain-events/) |
| `versions` | No | Typed chain of state versions (`version(n, schema, options?)`). See [Actors & State](/concepts/actors-and-state/) |
| `lifecycle` | No | Connection handlers (`connect`, `disconnect`) |
| `services` | No | Async work run through the outbox: `{ fn(input, env, effect), errors?, retry?, timeoutMs?, onDone?, onError? }` per name. `effect` is `{ actorType, actorId, effectId, idempotencyKey, attempt, signal }`; `onError` gets a typed error. See [Side Effects](/concepts/side-effects/) |
| `observe` | No | `{ onTransition }` hook |
| `serialize` | No | Custom state serializer |
| `restore` | No | Custom state deserializer |

## `kit.message(zodSchema, handler | { guard, handler })`

Pairs a Zod validation schema with a message handler. Handlers are synchronous. Annotate the state type on the first parameter; the payload and `ctx` are typed by the schema and the kit.

```typescript
// Simple handler
const increment = counter.message(z.object({}), (state: CounterState, _payload, { caller }) => ({
  ...state, count: state.count + 1, lastUpdatedBy: caller,
}));

// With guard
const reset = counter.message(z.object({}), {
  guard: (_state: CounterState, _payload, ctx) => ctx.role === "admin",
  handler: () => ({ count: 0, lastUpdatedBy: "" }),
});
```

Guard receives `(state, payload, ctx)` where ctx has `{ role, caller, callerType, env }`.

The standalone `message()` and `timer()` exported by `@actor-kit/worker` take the same arguments, for code outside a kit; their `ctx.emit` accepts no events.

## Refusals and errors

`send()` — the Durable Object's RPC `stub.send(caller, callerType, message)`, `ActorRef.send` and `simulate()`'s `send` — returns `{ ok: true }` or a `Refusal`:

```typescript
type Refusal = {
  ok: false;
  code: RefusalCode;          // unknown_message | invalid_payload | guard_failed | wrong_state
                              // | no_role | not_initialized | invalid_delivery | actor_not_found
  message: string;            // a full sentence naming the fix
  expected?: readonly string[]; // what would have been accepted (message names, state names)
  details?: unknown;          // e.g. the Zod issues for invalid_payload
  docs: string;               // https://actorkit.dev/errors/<code>/
};
```

A WebSocket client receives the same fields in an `__error` frame, `{ type: "__error", messageType, code, message, expected?, details?, docs }`. `testActor()` throws a refusal as a `RefusalError` (`.code`, `.refusal`).

Every error the library throws is an `ActorKitError` (exported from `@actor-kit/core`) with a stable `code`, a `message` that names the fix, optional `details`, and a `docs` URL (`https://actorkit.dev/errors/<code>/`). `RefusalError` extends it.

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
