# 018: Server-Coordinated Undo/Redo

**Priority**: P3
**Status**: Proposal
**Inspired by**: `@xstate/store` v3 `undoRedo()` extension
**Depends on**: 014 (Extension System), 012 (SQLite Storage / Event Log)

## Problem

Real-time collaborative apps frequently need undo/redo. Currently there's no built-in support — each app must implement its own event history, replay logic, and caller scoping. This is error-prone, especially when multiple users are editing simultaneously (you must not undo another user's actions).

## Proposed API

Server-side extension that maintains per-caller undo history:

```typescript
const ServerClass = createMachineServer({ machine, schemas })
  .with(undoRedo({
    // Only track user-initiated mutations, not system events
    skipEvent: (event) => event.caller.type === 'system',
    // Group rapid edits (e.g., typing) into single undo steps
    getTransactionId: (event, snapshot) => {
      if (event.type === 'UPDATE_TEXT') return `text-${event.fieldId}`;
      return undefined; // each event is its own transaction
    },
  }));
```

### Client-Side

UNDO and REDO are regular client events:

```typescript
// Client sends undo/redo like any other event
client.trigger.UNDO();
client.trigger.REDO();

// Or with the existing API
client.send({ type: 'UNDO' });
```

### Caller Scoping

Each caller has their own undo stack. User A's undo doesn't affect User B's changes:

```typescript
// User A adds a todo, User B adds a todo
// User A sends UNDO → only User A's todo is removed
```

### Strategies

- **Event-sourced** (default): Stores events, replays from initial state on undo. Memory efficient, works with event log (012).
- **Snapshot**: Stores full snapshots at each step. Simpler, supports `historyLimit` to cap memory.

## Implementation

1. Extension hooks into `onEvent` to record events per caller
2. UNDO/REDO are system events handled by the extension before reaching the machine
3. Event-sourced strategy: replay all events minus the undone one(s) from initial state
4. Snapshot strategy: restore the previous snapshot directly
5. Transaction grouping via `getTransactionId` — same ID = single undo step
6. Redo stack cleared when caller sends a new non-undo event (standard undo/redo semantics)

### Key Files

- `src/extensions/undoRedo.ts` — new extension
- `src/types.ts` — UNDO/REDO system event types
- `src/createMachineServer.ts` — extension hook for event interception

## Open Questions

- Should undo history survive DO eviction? (Probably not — treat as ephemeral session state)
- Max undo depth? (Configurable, default 50?)
- How does undo interact with persistence migrations? (Undo history should be discarded on migration)

## Test Plan

1. **Basic undo/redo** — event → undo → state restored → redo → state re-applied
2. **Caller isolation** — User A undo doesn't affect User B's state
3. **Transaction grouping** — grouped events undo as one step
4. **Skip events** — system events (CONNECT, DISCONNECT) excluded from history
5. **Redo cleared on new event** — undo → new event → redo has no effect
6. **Empty operations** — undo with no history is a no-op
7. **Event-sourced replay** — replayed state matches original state
8. **Snapshot strategy** — history limit respected, old snapshots evicted
