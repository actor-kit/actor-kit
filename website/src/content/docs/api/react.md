---
title: actor-kit/react
description: React SDK reference.
---

The React export (`import from "actor-kit/react"`) provides context and hooks for React applications.

## `createActorContext(actorType)`

Creates a context object with Provider and hooks.

```typescript
import { createActorContext } from "actor-kit/react";

const CounterContext = createActorContext("counter");
```

### Returns

```typescript
{
  Provider: (props: ProviderProps) => ReactNode;
  useView: () => unknown;
  useSend: () => (event) => void;
  useRole: () => string | undefined;
  useConnectionState: () => ConnectionState;
  useSelector: <T>(selector, equalityFn?) => T;
}
```

## `<Provider>`

Manages the WebSocket connection lifecycle.

```tsx
<CounterContext.Provider
  actorId="my-counter"
  host="example.com"
  accessToken={jwt}
  onRedirect={(target) => router.push(`/zone/${target.actorId}`)}
>
  <CounterUI />
</CounterContext.Provider>
```

- Creates the client on mount
- Disconnects on unmount
- Reconnects when `actorId` or `accessToken` changes

## `useView()`

Returns the current view. Re-renders on every view update.

```tsx
function Counter() {
  const view = CounterContext.useView();
  return <div>{view?.count ?? "Loading..."}</div>;
}
```

## `useSend()`

Returns a stable `send` function. Never causes re-renders.

```tsx
function IncrementButton() {
  const send = CounterContext.useSend();
  return <button onClick={() => send({ type: "INCREMENT" })}>+</button>;
}
```

## `useRole()`

Returns the current role string. Re-renders when the role changes.

```tsx
function AdminPanel() {
  const role = CounterContext.useRole();
  if (role !== "admin") return null;
  return <button onClick={() => send({ type: "RESET" })}>Reset</button>;
}
```

## `useSelector(selector, equalityFn?)`

Derives a value from the view. Only re-renders when the derived value changes.

```tsx
function TodoCount() {
  const count = TodoContext.useSelector(
    (view) => view?.todos?.length ?? 0
  );
  return <span>{count} todos</span>;
}
```

The default equality function is `Object.is`. Pass a custom one for object comparisons:

```tsx
const todos = TodoContext.useSelector(
  (view) => view?.todos ?? [],
  (a, b) => JSON.stringify(a) === JSON.stringify(b),
);
```

## `useConnectionState()`

Returns the WebSocket connection state. Updates on real connection events (not just snapshots).

```tsx
function Status() {
  const state = CounterContext.useConnectionState();
  return <div className={state}>{state}</div>;
}
```
