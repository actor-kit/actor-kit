---
title: "@actor-kit/server"
description: Server-side utilities for JWT creation and data fetching.
---

The server package provides utilities for creating access tokens and fetching actor state from a trusted server environment (SSR loaders, API routes, etc.).

## `createAccessToken(props)`

Creates a JWT access token for authenticating with an actor.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `signingKey` | `string` | Secret key for signing (from `ACTOR_KIT_SECRET`) |
| `actorId` | `string` | Unique actor instance ID |
| `actorType` | `string` | Actor type (e.g., `"todo"`) |
| `callerId` | `string` | Identifier for the caller |
| `callerType` | `string` | `"client"` or `"service"` |

### Returns

`Promise<string>` — A signed JWT with claims:
- `jti` = actor ID
- `aud` = actor type
- `sub` = `{callerType}-{callerId}`
- `exp` = 30 days

### Example

```typescript
import { createAccessToken } from "@actor-kit/server";

const accessToken = await createAccessToken({
  signingKey: process.env.ACTOR_KIT_SECRET!,
  actorId: "todo-123",
  actorType: "todo",
  callerId: "user-456",
  callerType: "client",
});
```

## `createActorFetch<TMachine>(props)`

Creates a function for fetching actor state via HTTP.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `actorType` | `string` | Actor type (e.g., `"todo"`) |
| `host` | `string` | Worker host URL |

### Returns

A fetch function with signature:

```typescript
(props: {
  actorId: string;
  accessToken: string;
  input?: Record<string, unknown>;
  waitForEvent?: ClientEventFrom<TMachine>;
  waitForState?: StateValueFrom<TMachine>;
  timeout?: number;
  errorOnWaitTimeout?: boolean;
}) => Promise<{
  snapshot: CallerSnapshotFrom<TMachine>;
  checksum: string;
}>
```

### Wait options

- `waitForEvent` — Wait for a specific event before returning the snapshot (deep equality check)
- `waitForState` — Wait for the actor to reach a specific state value
- `timeout` — Max wait time in ms (default varies)
- `errorOnWaitTimeout` — If `true` (default), throws 408 on timeout. If `false`, returns current snapshot.

### Example

```typescript
import { createActorFetch } from "@actor-kit/server";
import type { TodoMachine } from "./todo.machine";

const fetchTodo = createActorFetch<TodoMachine>({
  actorType: "todo",
  host: "your-worker.workers.dev",
});

// Simple fetch
const { snapshot, checksum } = await fetchTodo({
  actorId: "todo-123",
  accessToken,
});

// Wait for a state
const { snapshot, checksum } = await fetchTodo({
  actorId: "todo-123",
  accessToken,
  waitForState: { loaded: "success" },
  timeout: 5000,
  errorOnWaitTimeout: false,
});
```
