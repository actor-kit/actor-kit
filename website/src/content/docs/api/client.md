---
title: "@actor-kit/client"
description: Browser client SDK reference.
---

The client package (`@actor-kit/client`) provides the browser-side SDK. No Cloudflare or React dependencies.

## `actorClient(contract)` / `actorClient<typeof Contract>({ roles, views })`

Creates a typed client factory, from the contract value or from just its roles and views.

### Keep zod out of the client bundle (recommended)

The contract value carries Zod schemas and message handlers; importing it into the browser pulls all of
Zod in (zod 4's classic build brings its locales: one port measured ~395 KB → ~860 KB). The client needs
only two zod-free parts: the **roles** (their order numbers the binary frames) and the **view schemas**.
Put them in their own module, have the contract use those same objects, and import the contract as a
type only:

```typescript
// counter.views.ts — no zod here
import { nullable, schema, string, uint32, view } from "@actor-kit/core";
export type CounterState = { count: number; lastUpdatedBy: string | null };
export const CounterView = schema({ count: uint32, lastUpdatedBy: nullable(string) });
export const counterRoles = { user: () => true };
export const counterViews = { user: view.shared(CounterView, (s: CounterState) => s) };

// counter.contract.ts — server and tests
import { counterRoles, counterViews } from "./counter.views";
export const CounterContract = counter.actor("counter", { roles: counterRoles, views: counterViews, /* … */ });

// counter.client.ts — browser
import { actorClient } from "@actor-kit/client";
import type { CounterContract } from "./counter.contract";
import { counterRoles, counterViews } from "./counter.views";

export const CounterClient = actorClient<typeof CounterContract>({ roles: counterRoles, views: counterViews });
```

The type argument types `view` and `send` from the contract; passing anything but the contract's own
`roles` and `views` is a type error. (In React, `actorContext<typeof CounterContract>()` needs no runtime
value at all.)

### Value import (server-side, tests, or when bundle size doesn't matter)

```typescript
import { actorClient } from "@actor-kit/client";
import { CounterContract } from "./counter.contract";

export const CounterClient = actorClient(CounterContract);
```

### `.create(options)`

Creates a runtime WebSocket connection. The client SDK does not handle authentication — your Worker is responsible for reading the caller identity and stamping it via `withCallerIdentity()` before forwarding to the DO. See [Quick Start](/getting-started/quick-start/) for the full pattern.

```typescript
const client = CounterClient.create({
  path: `/api/counter/${encodeURIComponent(counterId)}`, // through your Worker
  initialView: snapshot, // from server loader / getSnapshot()
});
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `path` | `string` | Yes | Path on your Worker, e.g. `/api/counter/counter-1` (the scheme follows the page: https → wss) |
| `host` | `string` | No | Host with optional port. Defaults to `window.location.host`; required outside a browser |
| `getToken` | `() => string \| Promise<string>` | No | Token sent on every (re)connect via `Sec-WebSocket-Protocol` |
| `initialView` | `TView` | Yes | Initial view from server (SSR snapshot). The client starts with this view immediately. |
| `onRedirect` | `(target: { actorType: string; actorId: string }) => void` | No | Called on redirect |
| `onError` | `(error: ClientError) => void` | No | Called when the actor refuses a message (or sends a frame the client cannot read). See below |

`ClientError` is the refusal from the actor's `__error` frame: `{ messageType, code, message, expected?, details?, docs }`. `messageType` is the refused message's `type`; `code` is a refusal code (`unknown_message`, `invalid_payload`, `guard_failed`, `wrong_state`, `no_role`, …) or `invalid_frame` for an error frame the client cannot read; `message` names the fix; `docs` links to `https://actorkit.dev/errors/<code>/`.

```typescript
const client = CounterClient.create({
  path: `/api/counter/${counterId}`,
  initialView: snapshot,
  onError: (error) => {
    if (error.code === "guard_failed") showToast(error.message);
  },
});
```

Reconnection is automatic and never gives up: after an unexpected close the client retries with exponential backoff (1 s, 2 s, 4 s … capped at 30 s), and retries at once when the browser fires `online` or the page becomes visible again. `disconnect()` cancels any pending retry.

### Returns: `ActorClient<TView, TMessage>`

```typescript
interface ActorClient<TView, TMessage> {
  readonly connectionState: ConnectionState;
  readonly view: TView;              // always defined — initialView guarantees it
  readonly role: string | undefined; // the caller's role; the view object itself carries no role
  subscribe(listener: (view: TView) => void): () => void;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  send(message: TMessage): void;
  trigger(type: string, payload?: Record<string, unknown>): void;
  disconnect(): void;
}
```

A decoded view is the role's view data only: it carries no `role` field. Read the role from
`client.role` (or `useRole()` in React); the server's `getSnapshot()` likewise returns `role` beside
the snapshot. If a component needs both in one object, add a `role` field to the view schema.

## Using the client

### `subscribe(listener)`

Called whenever the view updates. Returns an unsubscribe function. The view is fully typed:

```typescript
client.subscribe((view) => {
  // view is { count: number; lastUpdatedBy: string } — no casting needed
  console.log("Count:", view.count);
});
```

### `send(message)`

Sends a message to the actor. The message type is validated at compile time:

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
  path: "/counter/test",
  host: "example.com",
  initialView: { count: 0 },
  viewSchema: CounterView, // optional — enables binary decoding + typed view
});
```

The builder (`actorClient()`) is preferred — it provides better ergonomics and the same typed `create()` under the hood.
