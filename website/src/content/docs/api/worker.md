---
title: "@actor-kit/worker"
description: Core server-side package for running state machines in Cloudflare Durable Objects.
---

The worker package provides the Durable Object class factory and request router.

## `createMachineServer(props)`

Creates a Durable Object class that runs your XState machine with WebSocket support, persistence, and access control.

### Parameters

- `machine` — The XState v5 machine to run
- `schemas` — Zod schemas for runtime validation:
  - `clientEvent` — Schema for browser client events
  - `serviceEvent` — Schema for backend service events
  - `inputProps` — Schema for initialization props
- `options` — Configuration:
  - `persisted` — Whether to persist state to DO storage (default: `false`)

### Returns

A Durable Object class that you export from your Worker.

### Example

```typescript
import { createMachineServer } from "@actor-kit/worker";
import { todoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoServiceEventSchema,
  TodoInputPropsSchema,
} from "./todo.schemas";

export const Todo = createMachineServer({
  machine: todoMachine,
  schemas: {
    clientEvent: TodoClientEventSchema,
    serviceEvent: TodoServiceEventSchema,
    inputProps: TodoInputPropsSchema,
  },
  options: {
    persisted: true,
  },
});

export type TodoServer = InstanceType<typeof Todo>;
export default Todo;
```

## `createActorKitRouter<Env>(routes)`

Creates a request handler that routes HTTP and WebSocket requests to the correct Durable Object.

### Parameters

- `routes` — Array of actor type strings (e.g., `["todo", "game"]`)
- `Env` — Type parameter for your Worker environment bindings

### Returns

A function `(request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>` that handles:

- Actor creation and initialization
- Event routing to the correct actor
- JWT access token validation
- WebSocket upgrade for real-time connections

### Routing convention

Actor type names map to Durable Object bindings in SCREAMING_SNAKE_CASE:

| Actor type | DO binding |
|-----------|-----------|
| `"todo"` | `TODO` |
| `"game-session"` | `GAME_SESSION` |
| `"user-profile"` | `USER_PROFILE` |

Routes are served at `/api/{actor-type}/{actor-id}`.

### Example

```typescript
import { createActorKitRouter } from "@actor-kit/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Todo } from "./todo.server";

interface Env {
  TODO: DurableObjectNamespace<InstanceType<typeof Todo>>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<any> | unknown;
}

const router = createActorKitRouter<Env>(["todo"]);

export { Todo };

export default class Worker extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    if (request.url.includes("/api/")) {
      return router(request, this.env, this.ctx);
    }
    return new Response("API powered by ActorKit");
  }
}
```
