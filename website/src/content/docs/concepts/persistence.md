---
title: Persistence
description: How Actor Kit persists and restores actor state in Durable Objects.
---

Actor Kit can persist state to Durable Object storage so actors survive restarts, deployments, and inactivity evictions.

## Enabling persistence

Set `persisted: true` when creating your durable actor:

```typescript
export const Todo = createDurableActor({
  logic: todoLogic,
  events: { client: TodoClientSchema, service: TodoServiceSchema },
  input: TodoInputSchema,
  persisted: true,
});
```

## What gets persisted

When persistence is enabled:

1. **On creation**: Actor metadata is stored — `actorType`, `actorId`, initial caller, and input props.
2. **On each transition**: The full snapshot is written to the `PERSISTED_SNAPSHOT_KEY` in DO storage.
3. **On resume** (DO restart): The snapshot is restored, schema migrations are applied via `xstate-migrate`, and a `RESUME` system event is sent to the machine.

The snapshot format:

```typescript
{
  value: "ready",              // XState state value
  context: {
    public: { /* ... */ },
    private: { /* ... */ },
  },
  version?: number,            // For migration tracking
}
```

## Handling RESUME

When a Durable Object restarts (after eviction, deployment, or crash), the machine receives a `RESUME` event. You can handle this to perform any re-initialization:

```typescript
states: {
  ready: {
    on: {
      RESUME: {
        actions: "handleResume",
      },
    },
  },
},
```

## Auto-migration

If your machine's schema changes between deployments, `xstate-migrate` automatically handles snapshot migration. The `MIGRATE` system event is sent when the persisted snapshot's structure doesn't match the current machine definition.

## When to use persistence

- **Persisted**: Long-lived actors (user profiles, game rooms, collaborative documents)
- **Ephemeral**: Short-lived actors (temporary sessions, one-time computations)

Without persistence, actors lose state when the Durable Object is evicted from memory (typically after ~30 seconds of inactivity).
