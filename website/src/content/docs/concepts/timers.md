---
title: Timers
description: Durable timers and game loops.
---

## `after` — Durable Timers

`after` timers use DO Alarms. They survive hibernation and restarts.

```typescript
export const Session = actor("session", {
  // ...
  after: {
    "30 minutes": (state) => ({ ...state, status: "idle" }),
    "24 hours": (state) => ({ ...state, expired: true }),
  },
});
```

Durations are human-readable strings: `"30 seconds"`, `"5 minutes"`, `"1 hour"`, `"7 days"`.

### How it works

1. On spawn, the framework schedules a DO Alarm for the soonest timer
2. When the alarm fires, the handler runs as a transition (persists state, broadcasts views)
3. The next timer is scheduled
4. Each timer fires exactly once (fired timers are tracked)

### Single Alarm Slot

DOs only have one alarm slot. The framework manages a unified scheduler that picks the soonest alarm across `after` timers and outbox retries.

## `tick` — Game Loop

`tick` uses `setInterval` for high-frequency updates while WebSocket connections exist.

```typescript
export const Zone = actor("zone", {
  // ...
  tick: {
    frequency: 100,  // ms
    handler: (state) => ({
      ...state,
      entities: updatePositions(state.entities),
    }),
  },
});
```

### Lifecycle

- **Starts** when the first WebSocket connects
- **Stops** when the last WebSocket disconnects (DO can hibernate)
- **Resumes** when a new connection opens
- **Persistence**: throttled to max 1 persist per second (to avoid SQLite write amplification)

### Reentrancy Guard

If a tick handler is async and takes longer than the frequency, the next tick is skipped (not queued). This prevents overlapping updates.

## When to use which

| Use case | Timer type |
|----------|-----------|
| Session timeout | `after: { "30 minutes": handler }` |
| Auto-close auction | `after: { "1 hour": handler }` |
| Game loop (AI, physics) | `tick: { frequency: 100, handler }` |
| Scheduled cleanup | `after: { "24 hours": handler }` |
| Real-time position sync | `tick: { frequency: 50, handler }` |
