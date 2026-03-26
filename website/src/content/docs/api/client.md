---
title: actor-kit/client
description: Browser client SDK reference.
---

The client export (`import from "actor-kit/client"`) provides the browser-side SDK. No Cloudflare or React dependencies.

## `actorClient(viewSchema)`

Creates a typed client factory. The view type is **inferred from the schema** — no generics needed.

```typescript
import { actorClient } from "actor-kit/client";
import { CounterView } from "./counter";

// Define the client contract (co-locate with your actor definition)
export const CounterClient = actorClient(CounterView);
```

### `.events<TEvent>()`

Narrows the event type for strict `send()` typing:

```typescript
type CounterEvent =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "RESET" };

export const CounterClient = actorClient(CounterView).events<CounterEvent>();
```

Without `.events()`, `send()` accepts any `{ type: string }`.

### `.create(options)`

Creates a runtime WebSocket connection:

```typescript
const client = CounterClient.create({
  url: `wss://${location.host}/counters/${encodeURIComponent(counterId)}`,
  accessToken: token,
});
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | `string` | Yes | Full WebSocket URL |
| `accessToken` | `string` | Yes | JWT from `createAccessToken()` |
| `roleNames` | `string[]` | No | Role names for binary role index mapping |
| `maxReconnectAttempts` | `number` | No | Max reconnect attempts (default: 10) |
| `onRedirect` | `(target: { actorType: string; actorId: string }) => void` | No | Called on redirect |
| `onError` | `(error: { message: string; error: string }) => void` | No | Called on error |

### Returns: `ActorClient<TView, TEvent>`

```typescript
interface ActorClient<TView, TEvent> {
  readonly connectionState: ConnectionState;
  readonly view: TView | undefined;
  readonly role: string | undefined;
  subscribe(listener: (view: TView) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  send(event: TEvent): void;
  trigger(type: string, payload?: Record<string, unknown>): void;
  disconnect(): void;
}
```

## Using the client

### `subscribe(listener)`

Called whenever the view updates. Returns an unsubscribe function. The view is fully typed from the schema:

```typescript
client.subscribe((view) => {
  // view is { count: number; lastUpdatedBy: string } — no casting needed
  console.log("Count:", view.count);
});
```

### `send(event)`

Sends a message to the actor. The event type is validated at compile time when `.events<E>()` was used:

```typescript
client.send({ type: "INCREMENT" });  // ✓ compiles
client.send({ type: "INVALID" });    // ✗ compile error (with .events<>())
```

### `trigger(type, payload)`

Shorthand for `send`:

```typescript
client.trigger("INCREMENT", { amount: 5 });
// Same as: client.send({ type: "INCREMENT", amount: 5 })
```

### Reconnection

On unexpected disconnect, the client auto-reconnects with exponential backoff (1s → 30s, max 10 attempts). On reconnect, it sends a checksum of its last-known view — the server responds with either an ack (no data needed) or a fresh snapshot.

### Connection States

`"connecting"` → `"connected"` → `"disconnected"` → `"reconnecting"` → `"connected"`

## Low-level: `createActorClient(options)`

For cases where you don't need the builder pattern, `createActorClient()` is the underlying function:

```typescript
import { createActorClient } from "actor-kit/client";

const client = createActorClient({
  url: "wss://example.com/counter/test",
  accessToken: token,
  viewSchema: CounterView,  // optional — enables binary decoding + typed view
});
```

The builder (`actorClient()`) is preferred — it provides better ergonomics and the same typed `create()` under the hood.
