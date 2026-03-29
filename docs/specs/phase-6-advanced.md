# Phase 6: Advanced — Specification

## Goal

Advanced features: actor supervision and observability. States, invoke, and output have been moved to earlier phases or replaced by other patterns.

## Prerequisites

Phases 1-5 complete.

## What moved

- **Finite states** (sequential + parallel) → Phase 1
- **`invoke` (async on state entry)** → replaced by `request()` with `onDone`/`onError` (Phase 1)
- **`output()` escape hatch** → removed. Views handle everything. Multi-rate view sync in Phase 2.

## Deliverables

### 1. Actor supervision

```typescript
const gameServer = defineActor({
  // ...

  supervise: {
    "zone": {
      onCrash: "ZONE_CRASHED",
      onRestart: "ZONE_RESTARTED",
    },
  },

  on: {
    ZONE_CRASHED: (state, { actorId, error }) =>
      produce(state, d => {
        d.zoneStatus[actorId] = "crashed";
        d.pendingRestart.push(actorId);
      }),
    ZONE_RESTARTED: (state, { actorId }) =>
      produce(state, d => {
        d.zoneStatus[actorId] = "running";
      }),
  },
});
```

Requirements:
- An actor can supervise other actors of specific types
- `onCrash` / `onRestart` are message names delivered to the `on` block (same pattern as `request()` callbacks)
- Supervision is opt-in and one-way (supervisor watches, doesn't control lifecycle)
- Implemented via DO Alarm polling or CF analytics API (TBD — research needed)
- This is the most speculative feature — may be descoped

### 2. Observability hooks

```typescript
const todoList = defineActor({
  // ...

  observe: {
    onTransition: (prevState, nextState, event, ctx) => {
      // Log, trace, emit metrics
      ctx.emit({ queue: "METRICS", body: { event: event.type, duration: ctx.transitionMs } });
    },
  },
});
```

Requirements:
- `onTransition` fires after every successful transition (including state changes, lifecycle events, request callbacks)
- Receives previous state, next state, the event that triggered it, and context
- Can `emit()` for logging/metrics (goes through outbox)
- Does not affect state — observational only
- Optional

## Acceptance criteria

1. Supervision detects crashed actors and delivers messages to supervisor
2. `onTransition` hook fires for every transition with correct before/after state
