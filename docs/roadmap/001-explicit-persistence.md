# 001: Explicit Persistence Control

**Priority**: P0
**Status**: Proposal
**Affects**: `createMachineServer.ts`, types

## Problem

Actor-kit persists snapshots automatically after state transitions, but developers have no way to force immediate persistence or verify that persistence happened. In production (Piqolo), this manifests as:

1. **Object-spread hacks** to force dirty detection:
   ```typescript
   // Actual code from piqolo player.machine.ts
   forcePersistDiscoveredLenses: assign(({ context }) =>
     produce(context, (draft) => {
       // Force Actor-Kit to recognize as state change
       draft.public.discoveredLensIds = { ...draft.public.discoveredLensIds };
     })
   )
   ```

2. **localStorage fallbacks** because persistence timing is unpredictable:
   ```typescript
   // useLensPersistence hook
   localStorage.setItem('piqolo_lens_backup', JSON.stringify(lensData));
   ```

3. **Staggered setTimeout backups** to hedge against race conditions:
   ```typescript
   setTimeout(() => performBackup('lens_operation_delayed'), 500);
   setTimeout(() => performBackup('lens_operation_final'), 1000);
   ```

4. **Manual heap monitoring** to trigger pre-eviction backups:
   ```typescript
   if (performance.memory && performance.memory.usedJSHeapSize > 100 * 1024 * 1024) {
     performBackup('high_memory');
   }
   ```

None of these should be necessary. The framework should provide explicit control.

## Proposed API

### Option A: `flush()` in machine actions (recommended)

Make `flush` available as an action in XState machine definitions:

```typescript
// Before: hack with object spread
actions: assign(({ context }) =>
  produce(context, (draft) => {
    draft.public.discoveredLensIds = { ...draft.public.discoveredLensIds };
  })
)

// After: explicit flush
actions: [
  assign(({ context, event }) =>
    produce(context, (draft) => {
      draft.public.discoveredLensIds[event.lensId] = true;
    })
  ),
  "flush",  // Framework-provided action: persist snapshot NOW
]
```

Implementation: `flush` is a special action name recognized by `createMachineServer`. When the machine executes it, the server calls `this.ctx.storage.put(PERSISTED_SNAPSHOT_KEY, snapshot)` synchronously within the current transition.

### Option B: `storage.flush()` via event metadata

Since every event already carries `storage: DurableObjectStorage`, add a convenience:

```typescript
actions: ({ event }) => {
  // Already available — just document the pattern
  event.storage.put(PERSISTED_SNAPSHOT_KEY, snapshot);
}
```

This is lower-level but already possible. The issue is that the developer doesn't have access to the current snapshot inside an action without reconstructing it.

### Recommendation

**Option A** — it's declarative, works with XState's action system, and the framework handles serialization.

### Additional: `checkpoint(label)` for named snapshots

For crash recovery, allow named checkpoints:

```typescript
actions: [
  assign(/* ... */),
  { type: "checkpoint", params: { label: "post-lens-discovery" } },
]
```

Stored at `checkpoint:{label}` in DO storage. Recoverable via a new system event:

```typescript
// Service event
{ type: "RESTORE_CHECKPOINT", label: "post-lens-discovery" }
```

## Implementation

### Key files to change

| File | Change |
|------|--------|
| `src/createMachineServer.ts` | Intercept `flush` action, persist immediately. Add `checkpoint` action handler. |
| `src/types.ts` | Add `FlushAction` and `CheckpointAction` types to system actions. |
| `src/constants.ts` | Add `CHECKPOINT_PREFIX` constant. |

### Persistence flow change

Current:
```
Event → XState transition → snapshot subscription fires → persist
```

Proposed (with flush):
```
Event → XState transition → flush action detected → persist immediately
                          → snapshot subscription fires → persist (deduplicated by checksum)
```

The checksum comparison already prevents double-writes, so flush + automatic persistence won't conflict.

### Checkpoint storage

```typescript
// In createMachineServer.ts
if (action.type === "checkpoint") {
  const snapshot = this.actor.getSnapshot();
  const serialized = this.serializeSnapshot(snapshot);
  await this.ctx.storage.put(`checkpoint:${action.params.label}`, {
    snapshot: serialized,
    timestamp: Date.now(),
    eventSequence: this.eventSequence,  // If we add event numbering (see 004)
  });
}
```

## Test Plan

### Unit tests (`create-machine-server.test.ts`)

1. **Flush triggers immediate persistence**
   - Setup: Machine with `flush` action on a transition
   - Act: Send event that triggers the transition
   - Assert: `storage.put` called with `PERSISTED_SNAPSHOT_KEY` during (not after) the transition handler

2. **Flush deduplicates with automatic persistence**
   - Setup: Machine with `flush` action
   - Act: Send event
   - Assert: `storage.put` called exactly once (not twice) for the same checksum

3. **Checkpoint stores named snapshot**
   - Setup: Machine with `checkpoint` action
   - Act: Send event
   - Assert: `storage.put` called with `checkpoint:label` key

4. **Checkpoint restore recovers state**
   - Setup: Create checkpoint, then mutate state further
   - Act: Send `RESTORE_CHECKPOINT` event
   - Assert: State matches checkpoint snapshot

5. **Multiple checkpoints coexist**
   - Setup: Create checkpoints "a" and "b" at different states
   - Act: Restore "a"
   - Assert: State matches "a", "b" still exists in storage

### Integration tests

6. **Flush survives DO eviction**
   - Setup: Send event with flush, simulate DO eviction (destroy + recreate)
   - Assert: Restored state includes the flushed data

### Mutation testing targets

- `flush` action detection branch
- Checkpoint key construction
- Deduplication logic (checksum comparison)
