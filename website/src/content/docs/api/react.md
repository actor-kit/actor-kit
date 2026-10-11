---
title: "@actor-kit/react"
description: React SDK reference.
---

The React package (`@actor-kit/react`) provides typed context and hooks for React applications.

## `actorContext(contract)` / `actorContext<Contract>()`

Creates a typed React context. Accepts either a contract value or a contract type parameter.

### Type-only import (recommended for client bundles)

Use `import type` to keep Zod, handlers, and Cloudflare dependencies out of the browser bundle:

```typescript
// counter.context.ts
import { actorClient } from "@actor-kit/client";
import { actorContext } from "@actor-kit/react";
import type { CounterContract } from "./counter.contract";

export const CounterClient = actorClient<CounterContract>();
export const CounterCtx = actorContext<CounterContract>();
```

### Value import (server-side or when bundle size doesn't matter)

When running on the server (SSR, tests, scripts), you can pass the contract directly:

```typescript
import { actorContext } from "@actor-kit/react";
import { CounterContract } from "./counter.contract";

const CounterCtx = actorContext(CounterContract);
```

### Returns

```typescript
{
  Provider: (props: { client: ActorClient<TView, TMessage>; children: ReactNode }) => ReactNode;
  useView: () => TView | undefined;
  useSend: () => (message: TMessage) => void;
  useRole: () => string | undefined;
  useConnectionState: () => ConnectionState;
  useSelector: <T>(selector: (view: TView | undefined) => T, equalityFn?) => T;
}
```

## `<Provider>`

Provides the actor client to all child hooks. Takes a pre-created client instance — you control how and when the connection is created.

```tsx
function App({ counterId, callerId }: { counterId: string; callerId: string }) {
  const [client, setClient] = useState<ActorClient | null>(null);

  useEffect(() => {
    const c = CounterClient.create({
      path: `/api/counter/${encodeURIComponent(counterId)}?callerId=${encodeURIComponent(callerId)}`,
      initialView: { count: 0, lastUpdatedBy: "" },
    });
    setClient(c);
    return () => c.disconnect();  // Clean up on unmount or prop change
  }, [counterId, callerId]);

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
| `client` | `ActorClient<TView, TMessage>` | Yes | Client instance from `Factory.create()` |
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

Returns a stable `send` function typed to the contract's messages. Never causes re-renders.

```tsx
function IncrementButton() {
  const send = CounterCtx.useSend();
  // send is (message: CounterMessage) => void — inferred from contract
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

### Role-narrowed `useSelector(role, selector)`

When the contract has multiple views (one per role), the view is a discriminated union with a `role` field. Pass a role as the first argument to narrow the type before selecting:

```tsx
// Common fields — accessible without narrowing (exists on ALL role variants)
const players = GameCtx.useSelector((view) => view?.players);
// type: Player[] | undefined

// Role-specific fields — pass role to narrow
const revenue = GameCtx.useSelector("admin", (view) => view.revenue);
// type: number | undefined (undefined if current role isn't "admin")

const myScore = GameCtx.useSelector("player", (view) => view.myScore);
// type: number | undefined
```

This is useful when components are already role-gated:

```tsx
function AdminPanel() {
  const role = GameCtx.useRole();
  if (role !== "admin") return null;

  const revenue = GameCtx.useSelector("admin", (v) => v.revenue);
  const settings = GameCtx.useSelector("admin", (v) => v.settings);
  return <div>Revenue: {revenue}</div>;
}
```

**When to use which hook:**

| Hook | Re-renders on | Use for |
|------|--------------|---------|
| `useView()` | Every view update | Small views, debugging |
| `useSelector(fn)` | Only when derived value changes | Production components, lists, computed values |
| `useSelector(role, fn)` | Only when derived value changes | Role-specific fields from discriminated union views |
| `useSend()` | Never | Action buttons, forms |
| `useRole()` | Role changes only | Routing by permission, conditional UI |

## `useConnectionState()`

Returns the WebSocket connection state. Updates on real connection events.

```tsx
function Status() {
  const state = CounterCtx.useConnectionState();
  return <div className={state}>{state}</div>;
}
```

## Low-level: `createActorContext<TView, TMessage>()`

If you prefer explicit generics over the contract pattern:

```typescript
import { createActorContext } from "@actor-kit/react";

type MyView = { count: number };
type MyMessage = { type: "INCREMENT" } | { type: "DECREMENT" };

const MyCtx = createActorContext<MyView, MyMessage>();
```

The `actorContext(contract)` pattern is preferred — it infers types from the same schema used for binary encoding.
