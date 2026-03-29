---
title: "@actor-kit/client"
description: Browser client SDK reference.
---

The client package (`@actor-kit/client`) provides the browser-side SDK. No Cloudflare or React dependencies.

## `actorClient(contract)` / `actorClient(viewSchema)`

Creates a typed client factory. Accepts either a contract (from `defineActor()`) or a raw view schema.

### Contract-derived (recommended)

Events and views are inferred from the contract — no manual type unions needed:

```typescript
import { actorClient } from "@actor-kit/client";
import { CounterContract } from "./counter";

export const CounterClient = actorClient(CounterContract);
```

### `.create(options)`

Creates a runtime WebSocket connection. The client SDK does not handle authentication — your Worker is responsible for reading the caller identity and stamping it via `withCallerIdentity()` before forwarding to the DO. See [Quick Start](/getting-started/quick-start/) for the full pattern.

```typescript
const client = CounterClient.create({
  url: `wss://${location.host}/api/counter/${encodeURIComponent(counterId)}`,
});
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | `string` | Yes | Full WebSocket URL (routed through your Worker) |
| `accessToken` | `string` | No | JWT from `createAccessToken()` (only needed for token-based auth via `@actor-kit/worker/token`) |
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

Called whenever the view updates. Returns an unsubscribe function. The view is fully typed:

```typescript
client.subscribe((view) => {
  // view is { count: number; lastUpdatedBy: string } — no casting needed
  console.log("Count:", view.count);
});
```

### `send(event)`

Sends a message to the actor. The event type is validated at compile time:

```typescript
client.send({ type: "INCREMENT" });  // ✓ compiles
client.send({ type: "INVALID" });    // ✗ compile error (with contract-derived client)
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
import { createActorClient } from "@actor-kit/client";

const client = createActorClient({
  url: "wss://example.com/counter/test",
  viewSchema: CounterView,  // optional — enables binary decoding + typed view
});
```

The builder (`actorClient()`) is preferred — it provides better ergonomics and the same typed `create()` under the hood.
