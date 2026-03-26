---
title: Counter
description: A minimal shared counter with real-time sync.
---

The counter is the simplest actor — it demonstrates roles, messages, views, and real-time sync between multiple users.

**Source**: [`examples/counter/`](https://github.com/actor-kit/actor-kit/tree/main/examples/counter)

## What it demonstrates

- `actor()` with `init`, `roles`, `messages`, `views`
- `message()` with Zod validation
- `schema()` and `view()` for typed view projections
- Real-time sync: two browsers sharing the same counter
- Admin vs user roles via `callerType`
- Client connection: raw WebSocket, `createActorClient()`, and React hooks

## The Actor

```typescript
export const Counter = actor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, lastUpdatedBy: null }),

  roles: {
    admin: (_state, _caller, { callerType }) => callerType === "service",
    user: () => true,
  },

  messages: {
    admin: { INCREMENT: increment, DECREMENT: decrement, RESET: reset },
    user: { INCREMENT: increment, DECREMENT: decrement },
  },

  views: {
    admin: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })),
    user: view(CounterView, (state) => ({ count: state.count, lastUpdatedBy: state.lastUpdatedBy ?? "" })),
  },
});
```

Key points:
- **Admin** role gets `RESET` — regular users can't reset
- **Both roles** share `increment` and `decrement` handlers (same `message()` object referenced twice)
- **Views** are the same shape for both roles — in more complex actors, roles would see different projections

## The Client

The example uses raw WebSocket for simplicity. Since the example actors use `view(schema, fn)`, the server sends binary frames by default. The raw WebSocket client below handles JSON snapshots (for actors without a schema). The Worker serves inline HTML that connects, subscribes, and sends messages:

```javascript
// Get a token
const { token } = await fetch("/api/token?actorId=default").then(r => r.json());

// Connect via WebSocket (token passed as subprotocol)
const ws = new WebSocket(`ws://${location.host}/api/counter/default`, [`token.${token}`]);

// Receive view updates
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "snapshot") {
    document.getElementById("count").textContent = msg.data.count;
  }
});

// Send messages
document.getElementById("increment").onclick = () =>
  ws.send(JSON.stringify({ type: "INCREMENT" }));
```

### With the client SDK

A real app would use `actorClient()` for typed views, automatic reconnection, and binary delta decoding. The `subscribe` callback always receives the full, merged view — you never see raw deltas:

```typescript
import { actorClient } from "actor-kit/client";
import { CounterView } from "./counter";

type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

// Define once (co-locate with actor definition)
const CounterClient = actorClient(CounterView).events<CounterEvent>();

// Create a runtime connection
const client = CounterClient.create({
  url: `wss://${location.host}/api/counter/default`,
  accessToken: token,
});

client.subscribe((view) => {
  // view is typed: { count: number; lastUpdatedBy: string }
  document.getElementById("count")!.textContent = String(view.count);
});

client.send({ type: "INCREMENT" });
```

### With React

```tsx
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { CounterView } from "./counter";

type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" };

const CounterClient = actorClient(CounterView).events<CounterEvent>();
const CounterCtx = actorContext<typeof CounterClient>();

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
  const send = CounterCtx.useSend();   // (event: CounterEvent) => void

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
