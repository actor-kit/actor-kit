---
title: Counter
description: A minimal shared counter with real-time sync.
---

The counter is the simplest actor — it demonstrates the contract-first API, flat messages, guards, views, and real-time sync between multiple users.

**Source**: [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter)

## What it demonstrates

- `defineActor()` + `createActorClass()` — contract-first API
- Flat messages with optional guards
- `message()` with Zod validation
- `schema()` and `view()` for typed view projections
- Real-time sync: two browsers sharing the same counter
- Admin vs user roles via `callerType`
- Contract-derived client: typed `actorClient(contract)` — no manual event unions

## The Actor

```typescript
import { z } from "zod";
import { schema, view, uint32, string, defineActor, createActorClass, message } from "actor-kit";

type CounterState = { count: number; lastUpdatedBy: string | null };

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

export const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),

  roles: {
    admin: (_state, _caller, { callerType }) => callerType === "service",
    user: () => true,
  },

  messages: {
    INCREMENT: message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: state.count + 1,
        lastUpdatedBy: caller,
      }),
    ),
    DECREMENT: message(
      z.object({}),
      (state: CounterState, _payload, { caller }) => ({
        ...state,
        count: Math.max(0, state.count - 1),
        lastUpdatedBy: caller,
      }),
    ),
    RESET: message(z.object({}), {
      guard: (_state, _payload, ctx) => ctx.role === "admin",
      handler: () => ({ count: 0, lastUpdatedBy: null }),
    }),
  },

  views: {
    admin: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })),
    user: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })),
  },
});

export const Counter = createActorClass(CounterContract);
```

Key points:
- **Messages are flat** — not nested by role. `RESET` uses a guard to restrict to admin
- **`defineActor()`** returns a typed contract — `createActorClass()` converts it to a DO class
- **Both roles** can see `INCREMENT` and `DECREMENT` — guards are only needed for restricted actions
- **Views** are the same shape for both roles — in more complex actors, roles would see different projections

## The Client

### Vanilla TypeScript

Use `actorClient(contract)` for typed views, automatic reconnection, and binary delta decoding. Event types are inferred from the contract — no manual union needed:

```typescript
import { actorClient } from "actor-kit/client";
import { CounterContract } from "./counter";

// Events and views inferred from the contract
const CounterClient = actorClient(CounterContract);

// Get a token
const { token } = await fetch("/api/token?actorId=default").then(r => r.json());

// Create a runtime connection
const client = CounterClient.create({
  url: `ws://localhost:8787/api/counter/default`,
  accessToken: token,
});

// view is typed: { count: number; lastUpdatedBy: string }
client.subscribe((view) => {
  document.getElementById("count")!.textContent = String(view.count);
});

client.send({ type: "INCREMENT" });
```

### React

```tsx
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { CounterContract } from "./counter";

const CounterClient = actorClient(CounterContract);
const CounterCtx = actorContext(CounterContract);

function App({ counterId, token }: { counterId: string; token: string }) {
  const [client, setClient] = useState<ReturnType<typeof CounterClient.create> | null>(null);

  useEffect(() => {
    const c = CounterClient.create({
      url: `wss://${location.host}/api/counter/${encodeURIComponent(counterId)}`,
      accessToken: token,
    });
    setClient(c);
    return () => c.disconnect();
  }, [counterId, token]);

  if (!client) return null;

  return (
    <CounterCtx.Provider client={client}>
      <Counter />
    </CounterCtx.Provider>
  );
}

function Counter() {
  const view = CounterCtx.useView();   // { count: number; lastUpdatedBy: string } | undefined
  const send = CounterCtx.useSend();   // (event: CounterEvent) => void — inferred from contract

  return (
    <div>
      <span>{view?.count ?? "..."}</span>
      <button onClick={() => send({ type: "INCREMENT" })}>+</button>
      <button onClick={() => send({ type: "DECREMENT" })}>-</button>
    </div>
  );
}
```

## Try it

```bash
cd examples/counter
pnpm install
pnpm dev
# Open http://localhost:8787
# Open a second tab — both see the same counter
```
