# 009: Observability Hooks

**Priority**: P2
**Status**: Proposal
**Affects**: `createMachineServer.ts`, types

## Problem

Actor-kit has basic `DEBUG_LEVEL` logging but no structured observability. In production, you can't:

- Trace which events caused which transitions
- Monitor persistence latency
- Alert on error states
- Measure event processing time
- Track WebSocket connection health

## Proposed API

### Lifecycle hooks

```typescript
export const Todo = createMachineServer({
  machine: todoMachine,
  schemas: { /* ... */ },
  options: {
    persisted: true,
    hooks: {
      onTransition: ({ event, prevState, nextState, durationMs }) => {
        console.log(`[${event.type}] ${JSON.stringify(prevState.value)} → ${JSON.stringify(nextState.value)} (${durationMs}ms)`);
      },
      onPersist: ({ checksum, durationMs, eventSeq }) => {
        // Log persistence latency
      },
      onError: ({ error, event, state }) => {
        // Alert on errors
      },
      onConnect: ({ caller, activeConnections }) => {
        // Track connection count
      },
      onDisconnect: ({ caller, activeConnections, reason }) => {
        // Monitor disconnection patterns
      },
    },
  },
});
```

### Wide event / canonical log line pattern

For production observability, emit a single structured event per request:

```typescript
hooks: {
  onTransition: (ctx) => {
    // Single wide event with all context
    console.log(JSON.stringify({
      level: "info",
      actorType: "todo",
      actorId: ctx.actorId,
      eventType: ctx.event.type,
      callerType: ctx.event.caller.type,
      callerId: ctx.event.caller.id,
      prevState: ctx.prevState.value,
      nextState: ctx.nextState.value,
      durationMs: ctx.durationMs,
      eventSeq: ctx.event._seq,
      timestamp: ctx.event._timestamp,
      activeConnections: ctx.activeConnections,
    }));
  },
}
```

## Implementation

Hooks are called synchronously (they should not block the event loop). If a hook throws, the error is logged but does not affect the actor.

```typescript
// In createMachineServer.ts
private callHook<T extends keyof Hooks>(name: T, data: HookData[T]) {
  try {
    this.options.hooks?.[name]?.(data);
  } catch (err) {
    console.error(`[actor-kit] Hook ${name} threw:`, err);
  }
}
```

## Test Plan

1. **onTransition called on every state change** with correct prev/next state
2. **onPersist called after storage.put** with duration
3. **onError called on machine error** without crashing the actor
4. **onConnect/onDisconnect called** with correct caller and connection count
5. **Hook errors don't crash the actor**
6. **Hooks are optional** — no errors when omitted
