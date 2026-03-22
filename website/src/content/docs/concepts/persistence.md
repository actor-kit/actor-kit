---
title: Persistence
description: How Actor Kit persists and restores state across Durable Object restarts.
---

Actor Kit persists state to Durable Object storage so actors survive restarts, deployments, and inactivity evictions.

## How it works

State is always persisted. On each transition, `createDurableActor` calls `logic.serialize(state)` and writes the result to DO storage. When the DO restarts, it calls `logic.restore(serialized)` to recreate the state.

```
Transition ──> logic.serialize(state) ──> DO storage
DO restart ──> DO storage ──> logic.restore(serialized) ──> state
```

## What gets persisted

1. **On creation**: Actor metadata — `actorType`, `actorId`, initial caller, and input
2. **On each transition**: Serialized state via `logic.serialize(state)`
3. **On resume** (DO restart): State restored via `logic.restore()`, then `logic.onResume()` if provided

## Migration

When your state shape changes between deployments, you need migration. How you handle it depends on your adapter:

### Plain reducers / Redux / @xstate/store

Provide a `version` number and a `migrate` function:

```typescript
const logic = defineLogic({
  // ...
  version: 2,
  migrate: (serialized, persistedVersion) => {
    if (persistedVersion === 1) {
      // Add new field that didn't exist in v1
      return { ...serialized, newField: "default" };
    }
    return serialized;
  },
});
```

Migration only runs when the persisted version differs from the current version.

### XState adapter

`fromXStateMachine` provides automatic migration via `xstate-migrate`. It compares the persisted snapshot's structure against the current machine definition and generates migrations automatically — no version numbers needed.

```typescript
const logic = fromXStateMachine(todoMachine, { getView });
// Migration is automatic — xstate-migrate handles it
```

## Lifecycle hooks

When a DO restarts and state is restored, `logic.onResume(state)` is called if provided. Use this for re-initialization:

```typescript
const logic = defineLogic({
  // ...
  onResume: (state) => ({
    ...state,
    reconnectedAt: Date.now(),
  }),
});
```

## Serialize and restore

By default, `defineLogic` uses `JSON.parse(JSON.stringify(state))` for serialization. If your state contains non-JSON-safe values (Dates, Maps, Sets), provide custom functions:

```typescript
const logic = defineLogic({
  // ...
  serialize: (state) => ({
    ...state,
    createdAt: state.createdAt.toISOString(),
  }),
  restore: (serialized) => ({
    ...serialized,
    createdAt: new Date(serialized.createdAt),
  }),
});
```

## DO eviction

Cloudflare evicts inactive Durable Objects after ~30 seconds of no requests. With persistence, this is transparent — the state is restored on the next request. Without persistence, the actor starts fresh.
