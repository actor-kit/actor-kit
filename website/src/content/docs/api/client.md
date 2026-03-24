---
title: actor-kit/client
description: Browser client SDK reference.
---

The client export (`import from "actor-kit/client"`) provides the browser-side SDK. No Cloudflare dependencies.

## `createActorClient(options)`

Connects to an actor via WebSocket and provides a reactive API.

```typescript
import { createActorClient } from "actor-kit/client";

const client = createActorClient({
  actorType: "counter",
  actorId: "my-counter",
  host: "example.com",
  accessToken: jwt,
});
```

### Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `actorType` | `string` | Yes | Actor type name |
| `actorId` | `string` | Yes | Actor instance ID |
| `host` | `string` | Yes | Worker hostname |
| `accessToken` | `string` | Yes | JWT from `createAccessToken()` |
| `viewSchema` | `SchemaDefinition` | No | Schema for binary frame decoding |
| `roleNames` | `string[]` | No | Role names for binary role index mapping |
| `maxReconnectAttempts` | `number` | No | Max reconnect attempts (default: 10) |
| `onRedirect` | `function` | No | Called on `__redirect` control frame |

### Returns: `ActorClient`

```typescript
interface ActorClient {
  readonly connectionState: ConnectionState;
  readonly view: unknown;
  readonly role: string | undefined;
  subscribe(listener: (view: unknown) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  send(event: { type: string; [key: string]: unknown }): void;
  trigger(type: string, payload?: Record<string, unknown>): void;
  disconnect(): void;
}
```

### `subscribe(listener)`

Called whenever the view updates. Returns an unsubscribe function.

```typescript
const unsub = client.subscribe((view) => {
  console.log("Count:", view.count);
});
// Later:
unsub();
```

### `send(event)`

Sends a message to the actor. The server validates the payload and routes to the appropriate handler.

```typescript
client.send({ type: "INCREMENT", amount: 5 });
```

### `trigger(type, payload)`

Shorthand for `send`:

```typescript
client.trigger("INCREMENT", { amount: 5 });
// Same as: client.send({ type: "INCREMENT", amount: 5 })
```

### Reconnection

On unexpected disconnect, the client auto-reconnects with exponential backoff (1s → 30s, max 10 attempts). On reconnect, it sends a `__reconnect` message with the last known checksum — the server responds with either an ack (no data needed) or a fresh snapshot.

### Connection States

`"connecting"` → `"connected"` → `"disconnected"` → `"reconnecting"` → `"connected"`
