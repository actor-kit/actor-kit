---
title: "@actor-kit/types"
description: Shared types, schemas, and constants used across all Actor Kit packages.
---

The types package provides TypeScript types and Zod schemas that all other packages depend on.

## Key Types

### `ActorKitStateMachine<TEvent, TInput, TPrivateContext, TPublicContext>`

The constraint type for your XState machine. Use it with `satisfies` to ensure your machine has the correct shape:

```typescript
export const todoMachine = setup({ /* ... */ })
  .createMachine({ /* ... */ })
  satisfies ActorKitStateMachine<TodoEvent, TodoInput, TodoPrivateContext, TodoPublicContext>;
```

### `WithActorKitEvent<TEvent, TCallerType>`

Augments an event type with Actor Kit metadata (`caller`, `storage`, `env`, `requestInfo`):

```typescript
type TodoEvent =
  | WithActorKitEvent<TodoClientEvent, "client">
  | WithActorKitEvent<TodoServiceEvent, "service">
  | ActorKitSystemEvent;
```

### `WithActorKitInput<TInputProps>`

Augments input props with `id` and `caller`:

```typescript
type TodoInput = WithActorKitInput<{ accessCount: number }>;
// Results in: { accessCount: number; id: string; caller: { type: string; id: string } }
```

### `CallerSnapshotFrom<TMachine>`

Extracts the caller-scoped snapshot type from a machine. This is what clients receive and what `useSelector` operates on:

```typescript
type TodoSnapshot = CallerSnapshotFrom<typeof todoMachine>;
// { public: TodoPublicContext; private: TodoPrivateContext; value: StateValue }
```

### `ClientEventFrom<TMachine>`

Extracts the client event type from a machine:

```typescript
type TodoClientEvent = ClientEventFrom<typeof todoMachine>;
// { type: "ADD_TODO"; text: string } | { type: "TOGGLE_TODO"; id: string } | ...
```

### `ServiceEventFrom<TMachine>`

Extracts the service event type from a machine.

### `ActorKitSystemEvent`

The union of all system events:

```typescript
type ActorKitSystemEvent =
  | { type: "INITIALIZE"; caller: { type: "system"; id: string } }
  | { type: "CONNECT"; caller: { type: "system"; id: string }; clientId: string }
  | { type: "DISCONNECT"; caller: { type: "system"; id: string }; clientId: string }
  | { type: "RESUME"; caller: { type: "system"; id: string } }
  | { type: "MIGRATE"; caller: { type: "system"; id: string }; operations: any[] };
```

### `Caller`

```typescript
type Caller = {
  type: "client" | "service" | "system";
  id: string;
};
```

### `AnyActorServer`

Base type for Durable Object actor servers. Used in the `Env` interface for Worker bindings:

```typescript
interface Env {
  TODO: DurableObjectNamespace<AnyActorServer>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
}
```
