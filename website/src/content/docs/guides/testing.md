---
title: Testing
description: Test your Actor Kit actors without a live server using mock clients and the transition helper.
---

Actor Kit provides two testing approaches:

1. **Mock client** — test your React components with fake state, no server needed
2. **Transition helper** — test your actor logic as a pure function

> **Source code**: [packages/test](https://github.com/actor-kit/actor-kit/tree/main/packages/test)

## Mock client

`createActorKitMockClient` creates a client with the same API as the real one, but backed by in-memory state. Use it to test React components in isolation.

```typescript
import { createActorKitMockClient } from "@actor-kit/test";

type CounterView = { count: number };
type CounterEvent = { type: "INCREMENT" } | { type: "RESET" };

const client = createActorKitMockClient<CounterView, CounterEvent>({
  initialSnapshot: { count: 0 },
  onSend: (event) => {
    if (event.type === "INCREMENT") {
      client.produce((draft) => { draft.count += 1; });
    }
  },
});

// Same API as the real client
client.getState();           // { count: 0 }
client.send({ type: "INCREMENT" });
client.getState();           // { count: 1 }

// Selectors
const count = client.select((s) => s.count);
count.get();                 // 1

// Trigger API
client.trigger.INCREMENT();
```

### Testing React components

```tsx
import { CounterContext } from "./counter.context";

const client = createActorKitMockClient<CounterView, CounterEvent>({
  initialSnapshot: { count: 42 },
});

render(
  <CounterContext.ProviderFromClient client={client}>
    <Counter />
  </CounterContext.ProviderFromClient>
);

expect(screen.getByText("Count: 42")).toBeInTheDocument();
```

## Transition helper

`transition()` tests your actor logic as a pure function — no DO, no WebSocket.

```typescript
import { transition } from "@actor-kit/test";

const result = transition(counterLogic, {
  event: { type: "INCREMENT" },
  caller: { type: "client", id: "user-1" },
});

expect(result.view.count).toBe(1);
expect(result.state.count).toBe(1);
```

### Chaining transitions

```typescript
const first = transition(counterLogic, {
  event: { type: "INCREMENT" },
  caller: { type: "client", id: "user-1" },
});

const second = transition(counterLogic, {
  state: first.state,
  event: { type: "INCREMENT" },
  caller: { type: "client", id: "user-1" },
});

expect(second.view.count).toBe(2);
```

## Workers integration tests

For end-to-end testing with real Durable Objects, use `@cloudflare/vitest-pool-workers`. See the [example tests](https://github.com/actor-kit/actor-kit/tree/main/packages/core/tests/workers).
