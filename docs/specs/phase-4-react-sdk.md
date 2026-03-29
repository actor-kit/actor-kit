# Phase 4: React SDK — Specification

## Goal

React bindings for Actor Kit: context, provider, hooks. After this phase, a React app can connect to an actor with `<Provider>` and consume views with `useView()`.

## Prerequisites

Phase 3 complete. Client SDK working.

## Deliverables

### 1. `actorContext()`

**File**: `packages/react/src/actor-context.ts`

```typescript
import { actorContext } from "@actor-kit/react";
import { todoContract } from "./contracts/todo";

const TodoContext = actorContext(todoContract);
```

Returns an object with: `Provider`, `useView`, `useSend`, `useRole`, `useSelector`, `useConnectionState`.

### 2. Provider

```tsx
<TodoContext.Provider
  actorId="my-list"
  host="example.com"
  accessToken={jwt}
  onRedirect={(target) => router.push(`/zone/${target.actorId}`)}
>
  <TodoList />
</TodoContext.Provider>
```

Requirements:
- Creates client via `actorClient(contract).create()` on mount
- Disconnects on unmount
- Provides connection context to children
- `accessToken` can change (reconnects with new token)
- `actorId` can change (disconnects from old, connects to new)
- Renders children only after initial SNAPSHOT received (or provide loading state)

### 3. Hooks

```typescript
// Full view (re-renders on any view change)
const view = TodoContext.useView();

// Selected slice (re-renders only when selection changes)
const todoCount = TodoContext.useSelector(v => v.role === "viewer" ? v.todoCount : v.todos.length);

// Send function (stable reference)
const send = TodoContext.useSend();

// Current role
const role = TodoContext.useRole();

// Connection state
const state = TodoContext.useConnectionState();
```

Requirements:
- `useView()` — returns current view. Re-renders on every view update. Use `useSelector` for performance.
- `useSelector(selector, equalityFn?)` — derives a value from the view. Re-renders only when the derived value changes (shallow equality by default).
- `useSend()` — returns a stable `send` function. Never causes re-renders.
- `useRole()` — returns current role string. Re-renders when role changes.
- `useConnectionState()` — returns connection state. Re-renders on state transitions.

### 4. SSR support

Requirements:
- Provider accepts optional `initialView` for SSR hydration
- If `initialView` provided, render immediately (no loading state)
- After hydration, connect WebSocket and switch to live updates
- Checksum from server-rendered snapshot used for reconnect delta

## Acceptance criteria

1. Provider connects on mount, disconnects on unmount
2. `useView()` re-renders when view changes
3. `useSelector()` only re-renders when selected value changes
4. `useSend()` returns stable reference across re-renders
5. Role change triggers `useRole()` re-render
6. SSR: renders immediately with `initialView`, hydrates to live connection
7. Zero `any` or `as` casts
8. No unnecessary re-renders (verify with React DevTools profiler)
