# 015: Pure Transition API for Testing

**Priority**: P1
**Status**: Accepted (implemented 2026-03-19)
**Inspired by**: `@xstate/store` v3 `store.transition(state, event)` API

## Problem

Testing actor-kit state machines requires standing up `FakeDurableObjectState`, `FakeWebSocket`, `FakeStorage`, and other infrastructure. This is necessary for integration tests, but overkill when you just want to verify that an event produces the right context change. There's no way to test a transition as a pure function.

```typescript
// Current: ~15 lines of setup to test one state transition
const state = FakeDurableObjectState.create("test-id");
const env = createTestEnv();
const server = new ServerClass(state, env);
await server.spawn({ id: "test-id", caller: testCaller, ... });
await server.send({ type: "ADD_TODO", text: "Buy milk", caller: testCaller, ... });
const snapshot = await server.getSnapshot(testCaller);
expect(snapshot.public.todos).toHaveLength(1);
```

## Proposed API

A pure `transition()` function that takes a snapshot + event and returns `[nextSnapshot, effects]`:

```typescript
import { transition } from '@actor-kit/test';

// Pure — no DO, no WebSocket, no storage
const [next, effects] = transition(machine, {
  snapshot: initialSnapshot,
  event: { type: 'ADD_TODO', text: 'Buy milk' },
  caller: { type: 'client', id: 'user-1' },
});

expect(next.context.public.todos).toHaveLength(1);
expect(effects).toContainEqual(
  expect.objectContaining({ type: 'notification.send' })
);
```

### Caller-Scoped Output

The return includes the caller-scoped view, matching what clients actually receive:

```typescript
const [next] = transition(machine, {
  snapshot: initialSnapshot,
  event: { type: 'SET_NICKNAME', name: 'Alice' },
  caller: { type: 'client', id: 'user-1' },
});

// Verify caller-scoped snapshot (what the client would see)
expect(next.callerSnapshot.private.nickname).toBe('Alice');
// Verify full context (what the server stores)
expect(next.context.private['user-1'].nickname).toBe('Alice');
```

## Implementation

1. Extract the event augmentation logic from `createMachineServer.ts` into a pure function
2. Use XState's `getNextSnapshot()` under the hood
3. Separate effects (XState actions with side effects) from pure state changes
4. Provide mock `storage` and `env` objects that record calls instead of executing them

### Key Files

- `src/test.ts` — new `transition()` export
- `src/createMachineServer.ts` — extract augmentation logic into reusable function
- `src/types.ts` — `TransitionResult<TMachine>` type

## Test Plan

1. **Pure transition matches server behavior** — same event produces same context via `transition()` and full server
2. **Caller augmentation applied** — event gets `caller`, `storage`, `env` fields
3. **Effects captured but not executed** — side effects returned in array, not run
4. **Caller-scoped snapshot correct** — public + private[callerId] slicing works
5. **System events work** — INITIALIZE, CONNECT produce correct state
6. **No infrastructure required** — test runs without any fakes or mocks
