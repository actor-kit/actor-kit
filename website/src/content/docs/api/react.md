---
title: "@actor-kit/react"
description: React hooks and context provider for Actor Kit.
---

The React package provides a context-based integration with hooks for reading state and sending events.

## `createActorKitContext<TMachine>(actorType)`

Creates a context object with a Provider and hooks for a specific actor type.

### Parameters

- `TMachine` — Type parameter for your XState machine
- `actorType` — String identifier (e.g., `"todo"`)

### Returns

An object with:

| Member | Description |
|--------|-------------|
| `Provider` | Component that creates and manages the WebSocket client |
| `ProviderFromClient` | Component that accepts an existing client (for testing) |
| `useClient()` | Hook to access the raw `ActorKitClient` |
| `useSelector(selector)` | Hook to subscribe to derived state |
| `useSend()` | Hook to get the event sender function |
| `useMatches(stateValue)` | Hook to check if current state matches |
| `Matches` | Component for conditional rendering based on state |

## Provider

Wrap your component tree to establish the WebSocket connection:

```tsx
<TodoActorKitContext.Provider
  host="your-worker.workers.dev"
  actorId="todo-123"
  accessToken="your-jwt-token"
  checksum="abc123"
  initialSnapshot={snapshot}
>
  <TodoList />
</TodoActorKitContext.Provider>
```

## `useSelector(selector)`

Subscribe to a slice of state. Re-renders only when the selected value changes (shallow comparison).

```tsx
// Select a single field
const todos = TodoActorKitContext.useSelector((s) => s.public.todos);

// Derived values
const completedCount = TodoActorKitContext.useSelector(
  (s) => s.public.todos.filter((t) => t.completed).length
);
```

## `useSend()`

Returns a function for sending client events:

```tsx
const send = TodoActorKitContext.useSend();

send({ type: "ADD_TODO", text: "Buy milk" });
send({ type: "TOGGLE_TODO", id: "todo-1" });
```

## `useMatches(stateValue)`

Check if the actor's current state matches a value:

```tsx
const isLoading = TodoActorKitContext.useMatches("loading");
const isReady = TodoActorKitContext.useMatches({ loaded: "success" });
```

## `useClient()`

Access the raw `ActorKitClient` for advanced use cases:

```tsx
const client = TodoActorKitContext.useClient();

// Wait for a condition
await client.waitFor((s) => s.public.todos.length > 0);
```

## `Matches` component

Conditional rendering based on state:

```tsx
<TodoActorKitContext.Matches state="loading">
  <p>Loading...</p>
</TodoActorKitContext.Matches>

<TodoActorKitContext.Matches state="error" not>
  <TodoList />
</TodoActorKitContext.Matches>

<TodoActorKitContext.Matches state="idle" or="ready">
  <p>Ready for action</p>
</TodoActorKitContext.Matches>
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `state` | `StateValue` | State value to match |
| `and?` | `StateValue` | Additional state to match (AND) |
| `or?` | `StateValue` | Alternative state to match (OR) |
| `not?` | `boolean` | Invert the match |
| `initialValueOverride?` | `boolean` | Override initial render value |
| `children` | `ReactNode` | Content to render when matched |
