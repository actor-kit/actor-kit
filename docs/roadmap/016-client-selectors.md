# 016: Framework-Agnostic Client Selectors

**Priority**: P2
**Status**: Accepted (implemented 2026-03-19)
**Inspired by**: `@xstate/store` v3 `store.select()` API

## Problem

Actor-kit's browser client notifies all subscribers on every JSON Patch application, even when only a small part of the snapshot changed. React users get `useSelector` via `createActorKitContext`, but non-React consumers have no way to subscribe to a slice of state efficiently. Even in React, the selector comparison happens in the component render cycle rather than at the subscription level.

```typescript
// Current: subscribes to ALL changes, must filter manually
client.subscribe((snapshot) => {
  // Fires on every patch, even if todos didn't change
  renderTodoList(snapshot.public.todos);
});
```

## Proposed API

`client.select(selector, equalityFn?)` returns a reactive selector with `.get()` and `.subscribe()`:

```typescript
const client = createActorKitClient(options);

// Create a selector — framework-agnostic
const todos = client.select(s => s.public.todos);

// Get current value
console.log(todos.get());

// Subscribe — only fires when todos actually change
todos.subscribe(todos => renderTodoList(todos));

// Custom equality for object slices
const stats = client.select(
  s => ({ total: s.public.todos.length, done: s.public.todos.filter(t => t.done).length }),
  (a, b) => a.total === b.total && a.done === b.done
);
```

### React Integration

`useSelector` could accept a client selector directly:

```typescript
const TodoContext = createActorKitContext<TodoMachine>();

function TodoCount() {
  // Option A: existing API (still works)
  const count = TodoContext.useSelector(s => s.public.todos.length);

  // Option B: pre-built selector (shared, memoized at subscription level)
  const count = TodoContext.useSelector(todoCountSelector);
}
```

## Implementation

1. Add `select()` method to `ActorKitClient` interface
2. Selector subscribes to client internally, compares selected value on each update
3. Only notifies selector subscribers when selected value changes (via equality check)
4. Default equality: `Object.is` (reference equality). Optional: `shallowEqual` export.
5. React `useSelector` detects selector objects and uses their `.get()` + `.subscribe()` directly

### Key Files

- `src/createActorKitClient.ts` — add `select()` method
- `src/selector.ts` — new file for `Selector` class and `shallowEqual`
- `src/createActorKitContext.tsx` — optimize `useSelector` to accept selectors
- `src/types.ts` — `ActorKitSelector<T>` type

## Test Plan

1. **Selector only fires when selected value changes** — 10 patches, 1 notification if value unchanged
2. **Custom equality function respected** — shallow equal prevents spurious updates
3. **Multiple selectors on same client** — independent, no cross-talk
4. **Selector works before connect** — returns initial/SSR state
5. **Selector unsubscribe cleans up** — no memory leaks
6. **React useSelector works with selector objects** — renders only on selected change
