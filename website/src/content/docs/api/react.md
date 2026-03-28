---
title: "actor-kit/react"
description: React SDK reference.
---

The React export (`import from "actor-kit/react"`) provides typed context and hooks for React applications.

## `actorContext(contract)` / `actorContext<typeof Factory>()`

Creates a typed React context. Accepts either a contract (from `defineActor()`) or a factory type parameter.

### Contract-derived (recommended)

Types are inferred from the contract — no manual generics:

```typescript
import { actorContext } from "actor-kit/react";
import { CounterContract } from "./counter";

const CounterCtx = actorContext(CounterContract);
```

### Factory-derived (legacy)

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
      url: `wss://${location.host}/api/counter/${encodeURIComponent(counterId)}`,
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

Returns the current view, typed from the contract's view schemas. Re-renders on every view update.

```tsx
function Counter() {
  const view = CounterCtx.useView();
  // view is { count: number; lastUpdatedBy: string } | undefined
  return <div>{view?.count ?? "Loading..."}</div>;
}
```

## `useSend()`

Returns a stable `send` function typed to the contract's message events. Never causes re-renders.

```tsx
function IncrementButton() {
  const send = CounterCtx.useSend();
  // send is (event: CounterEvent) => void — inferred from contract
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

Derives a value from the typed view. **Only re-renders when the derived value changes** — use this instead of `useView()` when your component only needs a slice of the view. This is the primary tool for render performance.

```tsx
// ✅ Good — only re-renders when count changes, ignores other view fields
function TodoCount() {
  const count = TodoCtx.useSelector((view) => view?.todos?.length ?? 0);
  return <span>{count} todos</span>;
}

// ❌ Avoid — re-renders on every view update, even if count didn't change
function TodoCount() {
  const view = TodoCtx.useView();
  return <span>{view?.todos?.length ?? 0} todos</span>;
}
```

The default equality function is `Object.is`. Pass a custom one for derived objects/arrays:

```tsx
const todos = TodoCtx.useSelector(
  (view) => view?.todos ?? [],
  (a, b) => a.length === b.length && a.every((t, i) => t.id === b[i]?.id && t.done === b[i]?.done),
);
```

**When to use which hook:**

| Hook | Re-renders on | Use for |
|------|--------------|---------|
| `useView()` | Every view update | Small views, debugging |
| `useSelector(fn)` | Only when derived value changes | Production components, lists, computed values |
| `useSend()` | Never | Action buttons, forms |
| `useRole()` | Role changes only | Conditional UI by permission |

## `useConnectionState()`

Returns the WebSocket connection state. Updates on real connection events.

```tsx
function Status() {
  const state = CounterCtx.useConnectionState();
  return <div className={state}>{state}</div>;
}
```

## Low-level: `createActorContext<TView, TEvent>()`

If you prefer explicit generics over the contract pattern:

```typescript
import { createActorContext } from "actor-kit/react";

type MyView = { count: number };
type MyEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

const MyCtx = createActorContext<MyView, MyEvent>();
```

The `actorContext(contract)` pattern is preferred — it infers types from the same schema used for binary encoding.
