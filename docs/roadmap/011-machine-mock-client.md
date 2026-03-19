# 011: Machine-Running Mock Client

**Priority**: P3
**Status**: Accepted (implemented 2026-03-19)
**Affects**: `createActorKitMockClient.ts`

## Problem

The current mock client stores state as a plain object. `produce()` lets tests mutate it directly, but the actual XState machine never runs. This means:

- Guards are never evaluated in Storybook
- Machine logic bugs aren't caught in stories
- Transitions that should be impossible can be simulated (misleading stories)
- Actions with side effects (like `sendTo`) are never executed

## Proposed API

### `createActorKitMachineClient` — mock client that runs the real machine

```typescript
import { createActorKitMachineClient } from "actor-kit/test"
import { todoMachine } from "./todo.machine"

const client = createActorKitMachineClient({
  machine: todoMachine,
  input: {
    id: "todo-123",
    caller: { id: "user-1", type: "client" },
    // ... ActorKitInputProps
  },
})

// send() goes through the real machine — guards evaluated, actions run
client.send({ type: "ADD_TODO", text: "Buy milk" })

// getState() returns the machine's actual snapshot
client.getState()
// { public: { todos: [{ id: "...", text: "Buy milk", completed: false }] }, ... }
```

### Coexistence with existing mock

The existing `createActorKitMockClient` remains for static/snapshot-based stories. The new client is for stories that need to test machine logic.

| | `createActorKitMockClient` | `createActorKitMachineClient` |
|---|---|---|
| Machine runs | No | Yes |
| Guards evaluated | No | Yes |
| `produce()` available | Yes | No (state driven by machine) |
| Use case | Visual QA, UI states | Logic testing, integration stories |
| Setup complexity | Low (just snapshot) | Higher (needs machine + input) |

### Stubbing external actors

For machines that invoke child actors (e.g., API calls, timers), provide stubs:

```typescript
const client = createActorKitMachineClient({
  machine: gameMachine,
  input: { /* ... */ },
  stubs: {
    // Stub the "answerTimer" invoked actor
    answerTimer: fromPromise(async () => {
      // Resolve immediately instead of waiting 25 seconds
      return undefined;
    }),
    // Stub the "parseQuestions" invoked actor
    parseQuestionsDocument: fromPromise(async () => {
      return { questions: [/* test questions */] };
    }),
  },
})
```

## Implementation

### Key changes

| File | Change |
|------|--------|
| `src/createActorKitMachineClient.ts` | New file: creates XState actor from machine, wraps in mock client interface |
| `src/types.ts` | Add `ActorKitMachineClient` type |
| Package exports (`/test`) | Export new function |

### Implementation sketch

```typescript
export function createActorKitMachineClient<TMachine>(options: {
  machine: TMachine;
  input: InputFrom<TMachine>;
  stubs?: Record<string, AnyActorLogic>;
}): ActorKitClient<TMachine> {
  const machine = options.stubs
    ? options.machine.provide({ actors: options.stubs })
    : options.machine;

  const actor = createActor(machine, { input: options.input });
  actor.start();

  const listeners = new Set<() => void>();

  actor.subscribe(() => {
    listeners.forEach((fn) => fn());
  });

  return {
    send: (event) => {
      actor.send(event);
      return Promise.resolve();
    },
    getState: () => {
      const snapshot = actor.getSnapshot();
      return {
        public: snapshot.context.public,
        private: snapshot.context.private,
        value: snapshot.value,
      } as CallerSnapshotFrom<TMachine>;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitFor: async (predicate, timeout = 5000) => {
      // Poll with timeout
    },
    connect: () => {},
    disconnect: () => {},
  };
}
```

## Test Plan

1. **Machine client runs real guards**
   - Setup: Machine with `isOwner` guard
   - Act: Send event from non-owner
   - Assert: State doesn't change (guard rejected)

2. **Machine client runs real actions**
   - Act: Send `ADD_TODO`
   - Assert: `getState().public.todos` has new item with generated UUID

3. **Stubs replace invoked actors**
   - Setup: Stub `answerTimer` to resolve immediately
   - Act: Start game
   - Assert: Timer completes instantly

4. **Subscribe notifies on transitions**
   - Setup: Subscribe to client
   - Act: Send event
   - Assert: Listener called

5. **Interface matches real client**
   - Assert: `createActorKitMachineClient` return type satisfies `ActorKitClient<TMachine>`
