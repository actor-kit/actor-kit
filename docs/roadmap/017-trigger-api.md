# 017: Typed Trigger API for Client Events

**Priority**: P3
**Status**: Proposal
**Inspired by**: `@xstate/store` v3 `store.trigger.eventName()` API

## Problem

Sending events requires constructing an object with a `type` discriminant. This is verbose and error-prone — typos in the type string aren't caught until runtime (Zod validation on the server).

```typescript
// Current: verbose, type string is just a string
client.send({ type: 'ADD_TODO', text: 'Buy milk' });
client.send({ type: 'TOGGLE_TODO', id: 'abc' });
```

## Proposed API

Auto-generated `.trigger` methods derived from the Zod event schemas:

```typescript
// Proposed: method per event type, payload is the remaining fields
client.trigger.ADD_TODO({ text: 'Buy milk' });
client.trigger.TOGGLE_TODO({ id: 'abc' });

// Events with no payload
client.trigger.CLEAR_COMPLETED();
```

### Type Safety

The trigger API is fully typed from `ClientEventSchema`:

```typescript
client.trigger.ADD_TODO({ text: 123 });
//                        ^^^^ Type error: string expected

client.trigger.NONEXISTENT();
//             ^^^^^^^^^^^ Type error: property does not exist
```

### `send()` Still Works

The existing `send()` API remains for programmatic event dispatch (e.g., forwarding events, dynamic types).

## Implementation

1. Generate a `trigger` proxy on `ActorKitClient` from the client event schema's discriminated union members
2. Each method calls `send({ type: eventType, ...payload })` internally
3. Type inference: extract union members from `ClientEventFrom<TMachine>`, map `{ type: T } & Rest` → `trigger.T(Rest)`
4. Proxy-based (no code generation) — intercepts property access, returns typed send wrapper

### Key Files

- `src/createActorKitClient.ts` — add `trigger` proxy
- `src/types.ts` — `TriggerAPI<TEvents>` mapped type

## Test Plan

1. **Trigger sends correct event** — `trigger.ADD_TODO({ text: 'x' })` equivalent to `send({ type: 'ADD_TODO', text: 'x' })`
2. **Trigger with no payload** — `trigger.CLEAR_COMPLETED()` sends `{ type: 'CLEAR_COMPLETED' }`
3. **Type errors for wrong payload** — compile-time check
4. **Type errors for unknown event** — compile-time check
5. **Works with event queue** — triggers queued before connection, flushed on connect
