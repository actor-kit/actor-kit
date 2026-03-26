---
title: actor-kit/react
description: React SDK reference.
---

The React export (`import from "actor-kit/react"`) provides typed context and hooks for React applications.

## `actorContext<typeof Factory>()`

Creates a typed React context from an `actorClient()` factory. Types are inferred from the factory — no manual generics for view or events.

```typescript
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";

const CounterClient = actorClient(CounterView).events<CounterEvent>();
const CounterCtx = actorContext<typeof CounterClient>();
```

### Returns

```typescript
{
  Provider: (props: { client: ActorClient<TView, TEvent>; children: ReactNode }) => ReactNode;
  useView: () => TView | undefined;
  useSend: () => (event: TEvent) => void;
  useRole: () => string | undefined;
  useConnectionState: () => ConnectionState;
  useSelector: <T>(selector: (view: TView | undefined) => T, equalityFn?) => T;
}
```

## `<Provider>`

Provides the actor client to all child hooks. Takes a pre-created client instance — you control how and when the connection is created.

```tsx
function App({ counterId, token }: { counterId: string; token: string }) {
  const [client, setClient] = useState<ActorClient | null>(null);

  useEffect(() => {
    const c = CounterClient.create({
      url: `wss://${location.host}/counters/${encodeURIComponent(counterId)}`,
      accessToken: token,
    });
    setClient(c);
    return () => c.disconnect();  // Clean up on unmount or prop change
  }, [counterId, token]);

  if (!client) return null;

  return (
    <CounterCtx.Provider client={client}>
      <Counter />
    </CounterCtx.Provider>
  );
}
```

Create the client in a `useEffect` to avoid WebSocket leaks — `createActorClient()` opens the connection immediately, and React StrictMode double-invokes the component body.

### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `client` | `ActorClient<TView, TEvent>` | Yes | Client instance from `Factory.create()` |
| `children` | `ReactNode` | Yes | Child components |

## `useView()`

Returns the current view, typed from the schema. Re-renders on every view update.

```tsx
function Counter() {
  const view = CounterCtx.useView();
  // view is { count: number; lastUpdatedBy: string } | undefined
  return <div>{view?.count ?? "Loading..."}</div>;
}
```

## `useSend()`

Returns a stable `send` function typed to the event union. Never causes re-renders.

```tsx
function IncrementButton() {
  const send = CounterCtx.useSend();
  // send is (event: CounterEvent) => void
  return <button onClick={() => send({ type: "INCREMENT" })}>+</button>;
}
```

## `useRole()`

Returns the current role string. Re-renders when the role changes.

```tsx
function AdminPanel() {
  const role = CounterCtx.useRole();
  const send = CounterCtx.useSend();
  if (role !== "admin") return null;
  return <button onClick={() => send({ type: "RESET" })}>Reset</button>;
}
```

## `useSelector(selector, equalityFn?)`

Derives a value from the typed view. Only re-renders when the derived value changes.

```tsx
function TodoCount() {
  const count = TodoCtx.useSelector((view) => view?.todos?.length ?? 0);
  return <span>{count} todos</span>;
}
```

The default equality function is `Object.is`. Pass a custom one for object comparisons:

```tsx
const todos = TodoCtx.useSelector(
  (view) => view?.todos ?? [],
  (a, b) => JSON.stringify(a) === JSON.stringify(b),
);
```

## `useConnectionState()`

Returns the WebSocket connection state. Updates on real connection events.

```tsx
function Status() {
  const state = CounterCtx.useConnectionState();
  return <div className={state}>{state}</div>;
}
```

## Low-level: `createActorContext<TView, TEvent>()`

If you prefer explicit generics over the factory pattern:

```typescript
import { createActorContext } from "actor-kit/react";

type MyView = { count: number };
type MyEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

const MyCtx = createActorContext<MyView, MyEvent>();
```

The `actorContext<typeof Factory>()` pattern is preferred — it infers types from the same schema used for binary encoding.
