# Actor Kit

Actor Kit runs event-driven state on the edge. Define your state transitions, and Actor Kit handles persistence, real-time sync, access control, and WebSocket communication — all inside Cloudflare Durable Objects.

**Bring your own state management.** Use plain reducers, XState, @xstate/store, Redux, or any library that does `state + event → next state`.

## Installation

```bash
# Core — no state library required
pnpm add @actor-kit/core @actor-kit/browser @actor-kit/react @actor-kit/server zod

# With XState (optional)
pnpm add @actor-kit/xstate xstate

# With @xstate/store (optional)
pnpm add @actor-kit/xstate-store @xstate/store

# With Redux (optional)
pnpm add @actor-kit/redux
```

## Quick Example

```typescript
import { defineLogic, createDurableActor } from "@actor-kit/core";
import { z } from "zod";

// Define your actor's behavior — just a reducer + a view function
const counter = defineLogic({
  create: () => ({ count: 0 }),

  transition: (state, event) => {
    switch (event.type) {
      case "INCREMENT":
        return { ...state, count: state.count + 1 };
      default:
        return state;
    }
  },

  // What each caller sees over the wire (caller-scoped projection)
  getView: (state, caller) => ({ count: state.count }),
});

// Wire it into a Cloudflare Durable Object
export const Counter = createDurableActor({
  logic: counter,
  events: {
    client: z.discriminatedUnion("type", [
      z.object({ type: z.literal("INCREMENT") }),
    ]),
    service: z.discriminatedUnion("type", [
      z.object({ type: z.literal("NOOP") }),
    ]),
  },
  input: z.object({}),
  persisted: true,
});
```

## Key Concepts

- **Event-driven state** — All state changes are driven by events. `state + event → next state`. No mutations, no side effects in transitions.
- **Caller-scoped views** — Each caller sees a different projection of the state. A game player sees their hand; a spectator sees the board. Defined by `getView(state, caller)`.
- **Real-time sync** — JSON Patch diffs over WebSocket. Clients stay current with minimal bytes. Reconnection with exponential backoff.
- **Persistence** — Opt-in snapshot persistence to Durable Object storage. Version-based migration support.
- **Type safety** — TypeScript generics at every layer. Zod validates events at runtime boundaries.
- **Framework integrations** — React hooks (`useSelector`, `useSend`). SSR support for Next.js and TanStack Start.

## Packages

| Package | Purpose |
|---------|---------|
| [`@actor-kit/core`](https://www.npmjs.com/package/@actor-kit/core) | `defineLogic`, `createDurableActor`, auth utilities |
| [`@actor-kit/browser`](https://www.npmjs.com/package/@actor-kit/browser) | WebSocket client, reconnection, state patching |
| [`@actor-kit/react`](https://www.npmjs.com/package/@actor-kit/react) | React context, hooks (`useSelector`, `useSend`) |
| [`@actor-kit/server`](https://www.npmjs.com/package/@actor-kit/server) | JWT creation, server-side data fetching |
| [`@actor-kit/xstate`](https://www.npmjs.com/package/@actor-kit/xstate) | XState v5 adapter |
| [`@actor-kit/xstate-store`](https://www.npmjs.com/package/@actor-kit/xstate-store) | @xstate/store adapter |
| [`@actor-kit/redux`](https://www.npmjs.com/package/@actor-kit/redux) | Redux reducer adapter |
| [`@actor-kit/test`](https://www.npmjs.com/package/@actor-kit/test) | Mock client, transition testing |
| [`@actor-kit/storybook`](https://www.npmjs.com/package/@actor-kit/storybook) | Storybook decorator |

## State Library Adapters

Use any event-driven state management library:

```typescript
// Plain reducer (no library)
import { defineLogic } from "@actor-kit/core";
const logic = defineLogic({ create, transition, getView });

// XState v5
import { fromXStateMachine } from "@actor-kit/xstate";
const logic = fromXStateMachine(myMachine, { getView });

// @xstate/store
import { fromXStateStore } from "@actor-kit/xstate-store";
const logic = fromXStateStore({ context, on }, { getView });

// Redux
import { fromRedux } from "@actor-kit/redux";
const logic = fromRedux(myReducer, { create, getView });

// All produce the same ActorLogic interface → createDurableActor({ logic })
```

## 🏗️ Architecture

```mermaid
graph TD
    subgraph "User Browser"
        A[Client Components<br>APIs: useSelector, useSend]
        B[Actor Kit Client<br>API: createActorKitClient]
    end

    subgraph "Cloudflare Worker"
        C[Actor Kit Router<br>API: createActorKitRouter]
        subgraph "Actor Server"
            D[Machine Server DO<br>API: createMachineServer]
            X[XState Machine]
            F[(Durable Object Storage)]
        end
    end

    subgraph "Server-Side Rendering"
        E[Next.js/TanStack Start/etc<br>APIs: createActorFetch, createAccessToken]
    end

    G[External API]
    H[(Database)]
    I[Third-party Service<br>e.g., Authentication, Payment, Analytics]

    A -->|Events| B
    B <-->|Send Events / Recv Patches| C
    C -->|Route| D
    D <-->|Manage State| X
    X <-->|Read/Write| F
    X --> G
    X --> H
    X --> I
    E <-->|Fetch/Send Events| C
    E -->|Deliver HTML/JS| A
    E <--> H

    classDef browser fill:#f0f0f0,stroke:#333,stroke-width:2px;
    classDef worker fill:#ffe6e6,stroke:#333,stroke-width:2px;
    classDef actorserver fill:#ffcccc,stroke:#333,stroke-width:2px;
    classDef ssr fill:#ffe6ff,stroke:#333,stroke-width:2px;
    classDef storage fill:#e6e6ff,stroke:#333,stroke-width:2px;
    classDef external fill:#e6ffff,stroke:#333,stroke-width:2px;

    class A,B browser;
    class C worker;
    class D,X,F actorserver;
    class E ssr;
    class G,H,I external;
```

## 🛠️ Usage

Here's a comprehensive example of how to use Actor Kit to create a todo list application with TanStack Start and Cloudflare Workers:

### 1️⃣ Define your event schemas and types

First, define the schemas and types for your events:

```typescript
// src/todo.schemas.ts
import { z } from "zod";

export const TodoClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ADD_TODO"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("TOGGLE_TODO"),
    id: z.string(),
  }),
  z.object({
    type: z.literal("DELETE_TODO"),
    id: z.string(),
  }),
]);

export const TodoServiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("SYNC_TODOS"),
    todos: z.array(
      z.object({ id: z.string(), text: z.string(), completed: z.boolean() })
    ),
  }),
]);

export const TodoInputPropsSchema = z.object({
  accessCount: z.number(),
});

// src/todo.types.ts
import type {
  ActorKitSystemEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "@actor-kit/types";
import { z } from "zod";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";

export type TodoClientEvent = z.infer<typeof TodoClientEventSchema>;
export type TodoServiceEvent = z.infer<typeof TodoServiceEventSchema>;
export type TodoInputProps = z.infer<typeof TodoInputPropsSchema>;
export type TodoInput = WithActorKitInput<TodoInputProps>;

export type TodoEvent =
  | WithActorKitEvent<TodoClientEvent, "client">
  | WithActorKitEvent<TodoServiceEvent, "service">
  | ActorKitSystemEvent;

export type TodoPublicContext = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  lastSync: number | null;
};

export type TodoPrivateContext = {
  accessCount: number;
};

export type TodoServerContext = {
  public: TodoPublicContext;
  private: Record<string, TodoPrivateContext>;
};
```

### 2️⃣ Define your state machine

Now that we have our event types defined, we can create our state machine:

```typescript
// src/todo.machine.ts
import { ActorKitStateMachine } from "@actor-kit/types";
import { assign, setup } from "xstate";
import type {
  TodoEvent,
  TodoInput,
  TodoPrivateContext,
  TodoPublicContext,
  TodoServerContext,
} from "./todo.types";

export const todoMachine = setup({
  types: {
    context: {} as TodoServerContext,
    events: {} as TodoEvent,
    input: {} as TodoInput,
  },
  actions: {
    addTodo: assign({
      public: ({ context, event }) => {
        if (event.type !== "ADD_TODO") return context.public;
        return {
          ...context.public,
          todos: [
            ...context.public.todos,
            { id: crypto.randomUUID(), text: event.text, completed: false },
          ],
          lastSync: Date.now(),
        };
      },
    }),
    // ... other actions ...
  },
  guards: {
    // ... guards ...
  },
}).createMachine({
  id: "todoList",
  initial: "idle",
  context: {
    public: {
      ownerId: caller.id,
      todos: [],
      lastSync: null,
    },
    private: {},
  },
  states: {
    idle: {
      on: {
        ADD_TODO: {
          actions: "addTodo",
        },
        // ... other transitions ...
      },
    },
    // ... other states ...
  },
}) satisfies ActorKitStateMachine<
  TodoEvent,
  TodoInput,
  TodoPrivateContext,
  TodoPublicContext
>;
```

### 3️⃣ Set up the Actor Server

Create the Actor Server using the `createMachineServer` function:

```typescript
// src/todo.server.ts
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

### 4️⃣ Configure Wrangler

Create a `wrangler.toml` file in your project root:

```toml
name = "nextjs-actorkit-todo"
main = "src/server.ts"
compatibility_date = "2024-09-25"

[vars]
ACTOR_KIT_SECRET = "foobarbaz"

[[durable_objects.bindings]]
name = "TODO"
class_name = "Todo"

[[migrations]]
tag = "v1"
new_classes = ["Todo"]
```

### 5️⃣ Create a Cloudflare Worker with Actor Kit Router

Create a new file, e.g., `src/server.ts`, to set up your Cloudflare Worker:

```typescript
// src/server.ts
import { DurableObjectNamespace } from "@cloudflare/workers-types";
import { AnyActorServer } from "@actor-kit/types";
import { createActorKitRouter } from "@actor-kit/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Todo, TodoServer } from "./todo.server";

interface Env {
  TODO: DurableObjectNamespace<TodoServer>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
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

### 6️⃣ Create the Actor Kit Context

```typescript
// src/todo.context.tsx
"use client";

import type { TodoMachine } from "./todo.machine";
import { createActorKitContext } from "@actor-kit/react";

export const TodoActorKitContext = createActorKitContext<TodoMachine>("todo");
export const TodoActorKitProvider = TodoActorKitContext.Provider;
```

### 7️⃣ Fetch data server-side

Using TanStack Start's `createServerFn` for server-side data loading:

```typescript
// src/routes/lists.$listId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createAccessToken, createActorFetch } from "@actor-kit/server";
import type { Caller } from "@actor-kit/types";
import { z } from "zod";
import { TodoActorKitProvider } from "../todo.context";
import type { TodoMachine } from "../todo.machine";
import { TodoList } from "../components/TodoList";

const ListRouteInputSchema = z.object({ listId: z.string().min(1) });

const loadTodoRoute = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => ListRouteInputSchema.parse(input))
  .handler(async ({ data }) => {
    const host = process.env.ACTOR_KIT_HOST!;
    const signingKey = process.env.ACTOR_KIT_SECRET!;
    const caller: Caller = { id: "demo-user", type: "client" };

    const accessToken = await createAccessToken({
      signingKey,
      actorId: data.listId,
      actorType: "todo",
      callerId: caller.id,
      callerType: caller.type,
    });

    const fetchTodoActor = createActorFetch<TodoMachine>({
      actorType: "todo",
      host,
    });

    const payload = await fetchTodoActor({
      actorId: data.listId,
      accessToken,
    });

    return { accessToken, host, listId: data.listId, payload, userId: caller.id };
  });

export const Route = createFileRoute("/lists/$listId")({
  loader: ({ params }) => loadTodoRoute({ data: { listId: params.listId } }),
  component: TodoRouteComponent,
});

function TodoRouteComponent() {
  const { accessToken, host, listId, payload, userId } = Route.useLoaderData();

  return (
    <TodoActorKitProvider
      host={host}
      actorId={listId}
      accessToken={accessToken}
      checksum={payload.checksum}
      initialSnapshot={payload.snapshot}
    >
      <TodoList userId={userId} />
    </TodoActorKitProvider>
  );
}
```

### 8️⃣ Create a client-side component

```typescript
// src/components/TodoList.tsx
"use client";

import { useState } from "react";
import { TodoActorKitContext } from "../todo.context";

export function TodoList({ userId }: { userId: string }) {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const ownerId = TodoActorKitContext.useSelector((state) => state.public.ownerId);
  const send = TodoActorKitContext.useSend();
  const [newTodoText, setNewTodoText] = useState("");
  const isOwner = ownerId === userId;

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTodoText.trim()) {
      send({ type: "ADD_TODO", text: newTodoText.trim() });
      setNewTodoText("");
    }
  };

  return (
    <div>
      <h1>Todo List</h1>
      <form onSubmit={handleAddTodo}>
        <input
          type="text"
          value={newTodoText}
          onChange={(e) => setNewTodoText(e.target.value)}
          placeholder="Add a new todo"
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span
              style={{
                textDecoration: todo.completed ? "line-through" : "none",
              }}
            >
              {todo.text}
            </span>
            <button onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}>
              {todo.completed ? "Undo" : "Complete"}
            </button>
            <button onClick={() => send({ type: "DELETE_TODO", id: todo.id })}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

This example demonstrates how to set up and use Actor Kit in a Next.js application with Cloudflare Workers, including:

1. Defining event schemas and types
2. Creating the state machine with proper typing
3. Setting up the Actor Server
4. Configuring Wrangler for Cloudflare Workers
5. Creating a Cloudflare Worker with Actor Kit Router
6. Setting up the Actor Kit context
7. Fetching data server-side with access token creation
8. Creating a client-side component that interacts with the actor

## 🚀 Getting Started

1. Install dependencies:

   ```bash
   npm install @actor-kit/types @actor-kit/worker @actor-kit/server xstate zod
   npm install -D wrangler
   ```

2. Set up environment variables:

   For development:
   Create a `.dev.vars` file in your project root:

   ```bash
   touch .dev.vars
   ```

   Add the following to `.dev.vars`:

   ```
   ACTOR_KIT_SECRET=your-secret-key
   ```

   Replace `your-secret-key` with a secure, randomly generated secret.

   For production:
   Set up the secret using Wrangler:

   ```bash
   npx wrangler secret put ACTOR_KIT_SECRET
   ```

   Enter the same secret key you used in your `.dev.vars` file.

3. Create a `wrangler.toml` file in your project root:

   ```toml
   name = "your-project-name"
   main = "src/server.ts"
   compatibility_date = "2024-09-25"

   [[durable_objects.bindings]]
   name = "YOUR_ACTOR"
   class_name = "YourActor"

   [[migrations]]
   tag = "v1"
   new_classes = ["YourActor"]
   ```

   Replace `your-project-name` with your project's name, and `YOUR_ACTOR` and `YourActor` with your specific actor names.

4. Create your Worker script (e.g., `src/server.ts`):

   ```typescript
   import { createActorKitRouter } from "@actor-kit/worker";
   import { YourActor } from "./your-actor.server";

   // Routes: /api/your-actor/{actorId}
   const actorKitRouter = createActorKitRouter(["your-actor"]);

   export { YourActor };

   export default {
     async fetch(
       request: Request,
       env: Env,
       ctx: ExecutionContext
     ): Promise<Response> {
       const url = new URL(request.url);

       if (url.pathname.startsWith("/api/")) {
         return actorKitRouter(request, env, ctx);
       }

       return new Response("Server powered by ActorKit");
     },
   };
   ```

   > **Note:** The route name in the array (e.g., `"your-actor"`) maps to the Durable Object binding name in SCREAMING_SNAKE_CASE (e.g., `YOUR_ACTOR` in `wrangler.toml`). Routes are served at `/api/{actor-type}/{actor-id}`.

5. Start the Cloudflare Worker development server:

   ```bash
   npx wrangler dev
   ```

6. Deploy your Worker to Cloudflare:

   ```bash
   npx wrangler deploy
   ```

7. If you're using Next.js or another external server, set up your `ACTOR_KIT_HOST` environment variable to point to your deployed Worker's URL.

By following these steps, you'll have a basic Actor Kit setup running on Cloudflare Workers. For more detailed, framework-specific instructions, please refer to our example projects for [Next.js](/examples/nextjs-actorkit-todo/README.md) and [TanStack Start](/examples/tanstack-start-actorkit-todo/README.md).

## 🗂️ Framework Examples

Actor Kit includes example todo list applications demonstrating integration with popular web frameworks.

- [TanStack Start example](/examples/tanstack-start-actorkit-todo/README.md) in `/examples/tanstack-start-actorkit-todo`
  - Full Cloudflare Workers deployment with Durable Objects
  - E2E tests with Playwright (15 tests covering CRUD, persistence, multi-client sync)
  - Preview deploys on every PR

- [Next.js example](/examples/nextjs-actorkit-todo/README.md) in `/examples/nextjs-actorkit-todo`

These examples showcase how to integrate Actor Kit with different frameworks, demonstrating real-time, event-driven todo lists with owner-based access control. Visit the live demos to see Actor Kit in action!

## 📖 API Reference

### 🔧 @actor-kit/worker

The `@actor-kit/worker` package provides the core functionality for running state machines in Cloudflare Workers. It includes utilities for creating machine servers and routing requests.

#### `createMachineServer<TClientEvent, TServiceEvent, TInputSchema, TMachine, Env>(props)`

Creates a server instance of a state machine that runs in a Cloudflare Worker Durable Object.

Parameters:
- `machine`: The XState machine to run on the server
- `schemas`: Zod schemas for validating events and input
  - `clientEvent`: Schema for events from clients
  - `serviceEvent`: Schema for events from trusted services
  - `inputProps`: Schema for initialization props
- `options`: Configuration options
  - `persisted`: Whether to persist state to storage (default: false)

Example usage:

```typescript
// src/todo.server.ts
import { createMachineServer } from "@actor-kit/worker";
import { todoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
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

Then set up your Cloudflare Worker to use the server:

```typescript
// src/server.ts
import { DurableObjectNamespace } from "@cloudflare/workers-types";
import { AnyActorServer } from "@actor-kit/types";
import { createActorKitRouter } from "@actor-kit/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Todo, TodoServer } from "./todo.server";

// Define environment interface with your Durable Object bindings
interface Env {
  TODO: DurableObjectNamespace<TodoServer>;
  ACTOR_KIT_SECRET: string;
  [key: string]: DurableObjectNamespace<AnyActorServer> | unknown;
}

// Create router with your actor types
const router = createActorKitRouter<Env>(["todo"]);

// Export your Durable Object class
export { Todo };

// Create your Worker
export default class Worker extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    if (request.url.includes("/api/")) {
      return router(request, this.env, this.ctx);
    }

    return new Response("API powered by ActorKit");
  }
}
```

Configure your `wrangler.toml`:

```toml
name = "your-project"
main = "src/server.ts"
compatibility_date = "2024-09-25"

[vars]
ACTOR_KIT_SECRET = "your-secret-key"

[[durable_objects.bindings]]
name = "TODO"
class_name = "Todo"

[[migrations]]
tag = "v1"
new_classes = ["Todo"]
```

The key components are:
1. Create your machine server with `createMachineServer`
2. Set up your Worker environment interface with Durable Object bindings
3. Create a router with your actor types
4. Export your Durable Object class
5. Create your Worker class that uses the router
6. Configure wrangler.toml with your Durable Object bindings

#### `createActorKitRouter<Env>(routes)`

Creates a router for handling Actor Kit requests in a Cloudflare Worker.

Parameters:
- `routes`: Array of actor type strings (e.g., `["todo", "game"]`)
- `Env`: Type parameter for your Worker's environment bindings

Returns a function that handles HTTP requests and routes them to the appropriate actor.

Example usage:

```typescript
const router = createActorKitRouter<Env>(["todo"]);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.url.includes("/api/")) {
      return router(request, env, ctx);
    }
    return new Response("API powered by ActorKit");
  }
};
```

The router handles:
- Actor creation and initialization
- Event routing to the correct actor
- Access token validation
- WebSocket connections for real-time updates 

### 🖥️ `@actor-kit/server`

#### `createActorFetch<TMachine>({ actorType, host })`

Creates a function for fetching actor data. Used in a trusted server environment, typically for server-side rendering or initial data fetching.

- `TMachine`: Type parameter extending `ActorKitStateMachine`
- `actorType`: String identifier for the actor type
- `host`: The host URL for the Actor Kit server

Returns a function with the following signature:

```typescript
(
  props: {
    actorId: string;
    accessToken: string;
    input?: Record<string, unknown>;
    waitForEvent?: ClientEventFrom<TMachine>;
    waitForState?: StateValueFrom<TMachine>;
    timeout?: number;
    errorOnWaitTimeout?: boolean;
  },
  options?: RequestInit
) =>
  Promise<{
    snapshot: CallerSnapshotFrom<TMachine>;
    checksum: string;
  }>;
```

The `waitForEvent`, `waitForState`, and `errorOnWaitTimeout` parameters allow you to specify conditions for when and how the snapshot should be returned:

- `waitForEvent`: Waits for a specific event to be received by the actor before returning the snapshot. The event object must match exactly (deep equality check) with the received event.
- `waitForState`: Waits for the actor to reach a specific state before returning the snapshot. State matching is performed as described in the XState documentation.
- `errorOnWaitTimeout`: Determines the behavior when a timeout occurs while waiting for an event or state. Default is `true`.
  - If `true` (default), throws a 408 (Request Timeout) error on timeout.
  - If `false`, returns a 200 status with the current snapshot, even if the wait condition wasn't met.

State matching works as follows:
- For simple states, an exact string match is performed.
- For compound states, a partial object match is performed. The provided state value must be a subset of the current state value.
- For parallel states, all specified regions must match.

Example usage:

```typescript
import { createActorFetch } from "@actor-kit/server";
import type { TodoMachine } from "./todo.machine";

const fetchTodoActor = createActorFetch<TodoMachine>({
  actorType: "todo",
  host: "your-worker.workers.dev",
});

// Wait for a specific event, throw error on timeout
const { snapshot, checksum } = await fetchTodoActor({
  actorId: "todo-123",
  accessToken: "your-access-token",
  waitForEvent: { type: "TODOS_LOADED" },
  timeout: 5000, // 5 seconds timeout
  errorOnWaitTimeout: true, // default behavior
});

// Wait for a specific state, return current snapshot on timeout
const { snapshot, checksum } = await fetchTodoActor({
  actorId: "todo-123",
  accessToken: "your-access-token",
  waitForState: { loaded: "success" },
  timeout: 5000, // 5 seconds timeout
  errorOnWaitTimeout: false,
});
```

Here's how to handle different timeout scenarios:

```typescript
try {
  // Scenario 1: Error on timeout (default behavior)
  const { snapshot, checksum } = await fetchTodoActor({
    actorId: "todo-123",
    accessToken: "your-access-token",
    waitForEvent: { type: "TODOS_LOADED" },
    timeout: 5000,
    // errorOnWaitTimeout: true, // This is the default
  });
  // Use the snapshot data
} catch (error) {
  if (error.status === 408) {
    console.error("Timeout waiting for actor response");
    // Handle timeout error (e.g., show an error message to the user)
  } else {
    console.error("Error fetching actor data:", error);
    // Handle other errors
  }
}

// Scenario 2: Return current snapshot on timeout
const { snapshot, checksum } = await fetchTodoActor({
  actorId: "todo-123",
  accessToken: "your-access-token",
  waitForState: { loaded: "success" },
  timeout: 5000,
  errorOnWaitTimeout: false,
});
// Always returns a snapshot, even if the wait condition wasn't met
// You may want to check if the desired state or event was reached
```

By using `waitForEvent` or `waitForState` along with `errorOnWaitTimeout`, you can control how your server-side rendering or initial data fetch behaves when waiting for specific actor states or events. This allows for flexible error handling and timeout management in your application.

#### `createAccessToken({ signingKey, actorId, actorType, callerId, callerType })`

Creates an access token for authenticating with an actor.

Parameters:

- `signingKey`: String used to sign the token
- `actorId`: Unique identifier for the actor
- `actorType`: Type of the actor
- `callerId`: Identifier for the caller
- `callerType`: Type of the caller (e.g., 'client', 'service')

Returns a Promise that resolves to a JWT token string.

Example usage:

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

### 🌐 `@actor-kit/browser`

#### `createActorKitClient<TMachine>(props: ActorKitClientProps<TMachine>)`

Creates an Actor Kit client for managing state and communication with the server.

- `TMachine`: Type parameter extending `ActorKitStateMachine`

`ActorKitClientProps<TMachine>` includes:

- `host`: String
- `actorType`: String
- `actorId`: String
- `checksum`: String
- `accessToken`: String
- `initialSnapshot`: `CallerSnapshotFrom<TMachine>`

Returns an `ActorKitClient<TMachine>` object with methods to interact with the actor.

Example usage:

```typescript
import { createActorKitClient } from "@actor-kit/browser";
import type { TodoMachine } from "./todo.machine";

const client = createActorKitClient<TodoMachine>({
  host: "your-worker.workers.dev",
  actorType: "todo",
  actorId: "todo-123",
  checksum: "initial-checksum",
  accessToken: "your-access-token",
  initialSnapshot: {
    public: { todos: [] },
    private: {},
    value: "idle",
  },
});

await client.connect();
client.send({ type: "ADD_TODO", text: "Buy milk" });
```

#### `ActorKitClient` Methods

- **`connect()`**: Establishes connection to the actor server
- **`disconnect()`**: Closes the connection to the actor server
- **`send(event)`**: Sends an event to the actor
- **`getState()`**: Returns the current state snapshot
- **`subscribe(listener)`**: Registers a listener for state changes
- **`waitFor(predicateFn, timeoutMs?)`**: Waits for a state condition to be met

##### Using `waitFor`

The `waitFor` method allows you to wait for specific state conditions:

```typescript
import { createActorKitClient } from '@actor-kit/browser';

const client = createActorKitClient<TodoMachine>({
  // ... client config
});

// Wait for a specific state value
await client.waitFor(state => state.value === 'ready');

// Wait for a condition with custom timeout
await client.waitFor(
  state => state.public.todos.length > 0,
  10000 // 10 seconds
);

// Wait for complex conditions
await client.waitFor(state => 
  state.public.todos.some(todo => todo.text === 'Buy milk' && todo.completed)
);
```

### ⚛️ `@actor-kit/react`

#### `createActorKitContext<TMachine>(actorType: string)`

Creates a React context and associated hooks and components for integrating Actor Kit into a React application.

- `TMachine`: Type parameter extending `ActorKitStateMachine`
- `actorType`: String identifier for the actor type

Returns an object with:

- `Provider`: React component to provide the Actor Kit client to its children
- `useClient()`: Hook to access the Actor Kit client directly
- `useSelector<T>(selector: (snapshot: CallerSnapshotFrom<TMachine>) => T)`: Hook to select and subscribe to specific parts of the state
- `useSend()`: Hook to get a function for sending events to the Actor Kit client
- `useMatches(stateValue: StateValueFrom<TMachine>)`: Hook to check if the current state matches a given state value
- `Matches`: Component for conditionally rendering based on state matches

Example usage:

```tsx
import { createActorKitContext } from "@actor-kit/react";
import type { TodoMachine } from "./todo.machine";

const TodoActorKitContext = createActorKitContext<TodoMachine>("todo");

function App() {
  return (
    <TodoActorKitContext.Provider
      host="your-worker.workers.dev"
      actorId="todo-123"
      accessToken="your-access-token"
      checksum="initial-checksum"
      initialSnapshot={{
        public: { todos: [] },
        private: {},
        value: "idle",
      }}
    >
      <TodoList />
    </TodoActorKitContext.Provider>
  );
}

function TodoList() {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const send = TodoActorKitContext.useSend();
  const isIdle = TodoActorKitContext.useMatches("idle");

  return (
    <div>
      {isIdle && <p>The todo list is idle</p>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            {todo.text}
            <button onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}>
              Toggle
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

#### `useClient()`

Hook to access the Actor Kit client directly.

Example usage:

```tsx
function TodoActions() {
  const client = TodoActorKitContext.useClient();

  const handleClearCompleted = () => {
    client.send({ type: "CLEAR_COMPLETED" });
  };

  return <button onClick={handleClearCompleted}>Clear Completed</button>;
}
```

#### `useSelector<T>(selector: (snapshot: CallerSnapshotFrom<TMachine>) => T)`

Hook to select and subscribe to specific parts of the state.

Example usage:

```tsx
function CompletedTodosCount() {
  const completedCount = TodoActorKitContext.useSelector(
    (state) => state.public.todos.filter((todo) => todo.completed).length
  );

  return <span>Completed todos: {completedCount}</span>;
}
```

#### `useSend()`

Hook to get a function for sending events to the Actor Kit client.

Example usage:

```tsx
function AddTodoForm() {
  const [text, setText] = useState("");
  const send = TodoActorKitContext.useSend();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      send({ type: "ADD_TODO", text: text.trim() });
      setText("");
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a new todo"
      />
      <button type="submit">Add</button>
    </form>
  );
}
```

#### `useMatches(stateValue: StateValueFrom<TMachine>)`

Hook to check if the current state matches a given state value.

Example usage:

```tsx
function LoadingIndicator() {
  const isLoading = TodoActorKitContext.useMatches("loading");

  return isLoading ? <div>Loading...</div> : null;
}
```

#### `Matches` Component

The `Matches` component allows for conditional rendering based on the current state of the actor machine.

Props:

- `state: StateValueFrom<TMachine>`: The state value to match against
- `and?: StateValueFrom<TMachine>`: Optional additional state to match (AND condition)
- `or?: StateValueFrom<TMachine>`: Optional alternative state to match (OR condition)
- `not?: boolean`: Invert the match result if true
- `children: ReactNode`: Content to render when the condition is met
- `initialValueOverride?: boolean`: Optional override for the initial render value

Example usage:

````tsx
function TodoList() {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const send = TodoActorKitContext.useSend();

  return (
    <div>
      <TodoActorKitContext.Matches state="idle">
        <p>The todo list is idle</p>
      </TodoActorKitContext.Matches>
      <TodoActorKitContext.Matches state="loading">
        <p>Loading todos...</p>
      </TodoActorKitContext.Matches>
      <TodoActorKitContext.Matches state="error" not>
        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              {todo.text}
              <button
                onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}
              >
                Toggle
              </button>
            </li>
          ))}
        </ul>
      </TodoActorKitContext.Matches>
    </div>
  );
}
````

You can also use the `Matches` component with more complex conditions:

````tsx
function TodoList() {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const send = TodoActorKitContext.useSend();

  return (
    <div>
      <TodoActorKitContext.Matches state="idle" or="ready">
        <p>The todo list is ready for action</p>
      </TodoActorKitContext.Matches>
      <TodoActorKitContext.Matches state="loading" and={{ data: "fetching" }}>
        <p>Fetching todos from the server...</p>
      </TodoActorKitContext.Matches>
      <TodoActorKitContext.Matches state="error" not>
        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              {todo.text}
              <button
                onClick={() => send({ type: "TOGGLE_TODO", id: todo.id })}
              >
                Toggle
              </button>
            </li>
          ))}
        </ul>
      </TodoActorKitContext.Matches>
    </div>
  );
}
````

### 🧪 @actor-kit/test

#### `createActorKitMockClient<TMachine>(props: ActorKitMockClientProps<TMachine>)`

Creates a mock client for testing Actor Kit state machines without needing a live server.

Parameters:
- `initialSnapshot`: Initial state snapshot for the mock client
- `onSend?`: Optional callback function invoked whenever an event is sent

Returns a mock client that implements the standard `ActorKitClient` interface plus additional testing utilities:
- All standard client methods (send, subscribe, etc.)
- `produce(recipe: (draft: Draft<CallerSnapshotFrom<TMachine>>) => void)`: Method for directly manipulating state using Immer

Example usage:

````typescript
import { createActorKitMockClient } from '@actor-kit/test';
import type { TodoMachine } from './todo.machine';

describe('Todo State Management', () => {
  it('should handle state transitions', () => {
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { 
          todos: [],
          status: 'idle'
        },
        private: {},
        value: 'idle'
      }
    });

    // Use Immer's produce to update state
    mockClient.produce((draft) => {
      draft.public.todos.push({
        id: '1',
        text: 'Test todo',
        completed: false
      });
    });

    expect(mockClient.getState().public.todos).toHaveLength(1);
  });

  it('should track sent events', () => {
    const sendSpy = vi.fn();
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: { /* ... */ },
      onSend: sendSpy
    });

    mockClient.send({ type: 'ADD_TODO', text: 'Test todo' });
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'ADD_TODO',
      text: 'Test todo'
    });
  });
});
````

### 📚 @actor-kit/storybook

#### `withActorKit<TMachine>({ actorType, context })`

Creates a Storybook decorator for testing components that depend on Actor Kit state.

Parameters:
- `actorType`: String identifier for the actor type
- `context`: The Actor Kit context created by `createActorKitContext`

Returns a Storybook decorator function.

Example usage:

````typescript
import { withActorKit } from '@actor-kit/storybook';
import { GameContext } from './game.context';
import type { GameMachine } from './game.machine';

const meta = {
  title: 'Components/GameView',
  component: GameView,
  decorators: [
    withActorKit<GameMachine>({
      actorType: "game",
      context: GameContext,
    }),
  ],
};
````

#### `StoryWithActorKit<TMachine>`

A utility type for stories that use Actor Kit state machines. It combines the standard Storybook story type with Actor Kit parameters.

Example usage:

````typescript
import type { StoryWithActorKit } from '@actor-kit/storybook';
import type { GameMachine } from './game.machine';

export const GameStory: StoryWithActorKit<GameMachine> = {
  parameters: {
    actorKit: {
      game: {
        "game-123": {
          public: { /* initial state */ },
          private: {},
          value: "idle"
        }
      }
    }
  }
}
````


### System Events

Actor Kit includes several system events that are automatically handled by the state machine. These events are of type `ActorKitSystemEvent` and include:

- `INITIALIZE`: Fired when an actor is first created.
- `CONNECT`: Fired when a client connects to the actor.
- `DISCONNECT`: Fired when a client disconnects from the actor.
- `RESUME`: Fired when an actor is resumed.
- `MIGRATE`: Fired when an actor needs to migrate its state, including an operations array.

The `ActorKitSystemEvent` type is defined as follows:

```typescript
export type ActorKitSystemEvent =
  | { type: "INITIALIZE"; caller: { type: "system" id: string } }
  | { type: "CONNECT"; caller: { type: "system"; id: string }; clientId: string }
  | { type: "DISCONNECT"; caller: { type: "system"; id: string }; clientId: string }
  | { type: "RESUME"; caller: { type: "system"; id: string } }
  | { type: "MIGRATE"; caller: { type: "system"; id: string }; operations: any[] };
```

These events can be handled in your state machine definition:

```typescript
createMachine({
  // ... other configuration ...
  states: {
    idle: {
      on: {
        INITIALIZE: {
          actions: "initializeActor",
        },
        CONNECT: {
          actions: "handleClientConnection",
        },
        DISCONNECT: {
          actions: "handleClientDisconnection",
        },
        RESUME: {
          actions: "handleActorResume",
        },
        MIGRATE: {
          actions: "handleActorMigration",
        },
        // ... other transitions ...
      },
    },
    // ... other states ...
  },
});
```

### 🧪 Testing with Mock Client

#### `createActorKitMockClient<TMachine>`

Creates a mock client for testing Actor Kit state machines without needing a live server. It implements the standard `ActorKitClient` interface plus additional testing utilities.

**Type Parameters:**
- `TMachine`: The type of the state machine, extending `AnyActorKitStateMachine`

**Parameters:**
- `props: ActorKitMockClientProps<TMachine>`: Configuration options including:
  - `initialSnapshot`: The initial state snapshot
  - `onSend?`: Optional callback function invoked whenever an event is sent

**Returns:**
An `ActorKitMockClient<TMachine>` with all standard client methods plus:
- `produce(recipe: (draft: Draft<CallerSnapshotFrom<TMachine>>) => void)`: Method for directly manipulating state using Immer

**Basic Example:**

```typescript
import { createActorKitMockClient } from '@actor-kit/test';
import type { TodoMachine } from './todo.machine';

describe('Todo State Management', () => {
  it('should handle state transitions', () => {
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { 
          todos: [],
          status: 'idle'
        },
        private: {},
        value: 'idle'
      }
    });

    // Use Immer's produce to update state
    mockClient.produce((draft) => {
      draft.public.todos.push({
        id: '1',
        text: 'Test todo',
        completed: false
      });
      draft.value = 'ready';
    });

    // Verify state changes
    expect(mockClient.getState().public.todos).toHaveLength(1);
    expect(mockClient.getState().value).toBe('ready');
  });
});
```

**Spying on Events:**

```typescript
import { vi } from 'vitest'; // or jest

describe('Todo Event Handling', () => {
  it('should track sent events', () => {
    const sendSpy = vi.fn();
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { 
          todos: [],
          status: 'idle'
        },
        private: {},
        value: 'idle'
      },
      onSend: sendSpy
    });

    // Send an event
    mockClient.send({ type: 'ADD_TODO', text: 'Test todo' });

    // Verify the event was sent
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'ADD_TODO',
      text: 'Test todo'
    });

    // Check call count
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Verify specific event properties
    const [sentEvent] = sendSpy.mock.calls[0];
    expect(sentEvent.type).toBe('ADD_TODO');
    expect(sentEvent.text).toBe('Test todo');
  });

  it('should track multiple events in order', () => {
    const sendSpy = vi.fn();
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { 
          todos: [{ id: '1', text: 'Test todo', completed: false }],
          status: 'idle'
        },
        private: {},
        value: 'idle'
      },
      onSend: sendSpy
    });

    // Send multiple events
    mockClient.send({ type: 'TOGGLE_TODO', id: '1' });
    mockClient.send({ type: 'DELETE_TODO', id: '1' });

    // Verify events were sent in order
    expect(sendSpy.mock.calls).toEqual([
      [{ type: 'TOGGLE_TODO', id: '1' }],
      [{ type: 'DELETE_TODO', id: '1' }]
    ]);
  });
});
```

**Testing React Components:**

```typescript
import { render, screen } from '@testing-library/react';
import { TodoActorKitContext } from './todo.context';
import { createActorKitMockClient } from '@actor-kit/test';

describe('TodoList', () => {
  it('renders todos correctly', () => {
    const mockClient = createActorKitMockClient<TodoMachine>({
      initialSnapshot: {
        public: { 
          todos: [],
          status: 'idle'
        },
        private: {},
        value: 'idle'
      }
    });

    render(
      <TodoActorKitContext.ProviderFromClient client={mockClient}>
        <TodoList />
      </TodoActorKitContext.ProviderFromClient>
    );

    // Update state using Immer
    mockClient.produce((draft) => {
      draft.public.todos.push({
        id: '1',
        text: 'Test todo',
        completed: false
      });
    });

    // Verify UI updates
    expect(screen.getByText('Test todo')).toBeInTheDocument();
  });
});
```

The mock client provides two powerful testing capabilities:

1. **State Manipulation**: The `produce` method uses Immer to allow intuitive, mutable-style updates to the immutable state. This makes it easy to set up different test scenarios.

2. **Event Tracking**: The `onSend` callback can be used with testing framework spies to verify that components are sending the correct events at the right times.

These features make it simple to test both state transitions and component behavior without needing a real server connection.

## 👥 Caller Types

Actor Kit supports different types of callers, each with its own level of trust and permissions:

- 👤 `client`: Events from end-users or client applications
- 🤖 `system`: Internal events generated by the actor system (handled internally)
- 🔧 `service`: Events from trusted external services or internal microservices

## 🔑 TypeScript Types

The following key types are exported from the `@actor-kit/types` package:

### `WithActorKitEvent<TEvent, TCallerType>`

Utility type that wraps an event type with Actor Kit-specific properties. This is crucial for adding caller information and other metadata to your events.

Example usage:

```typescript
import { WithActorKitEvent } from "@actor-kit/types";

type MyClientEvent =
  | { type: "ADD_TODO"; text: string }
  | { type: "TOGGLE_TODO"; id: string };

type MyServiceEvent = {
  type: "SYNC_TODOS";
  todos: Array<{ id: string; text: string; completed: boolean }>;
};

type MyEvent =
  | WithActorKitEvent<MyClientEvent, "client">
  | WithActorKitEvent<MyServiceEvent, "service">
  | ActorKitSystemEvent;
```

### `ActorKitSystemEvent`

Type representing system events that Actor Kit generates internally. These events are automatically included in your machine's event type and are used to handle lifecycle operations.

Key system events:

- `INITIALIZE`: Fired when an actor is first created or resumed from storage.
- `CONNECT`: Fired when a client connects to the actor.
- `DISCONNECT`: Fired when a client disconnects from the actor.

Example usage in a state machine:

```typescript
createMachine({
  // ... other configuration ...
  states: {
    idle: {
      on: {
        INITIALIZE: {
          actions: "initializeActor",
        },
        CONNECT: {
          actions: "handleClientConnection",
        },
        DISCONNECT: {
          actions: "handleClientDisconnection",
        },
        // ... other transitions ...
      },
    },
    // ... other states ...
  },
});
```

### `CallerSnapshotFrom<TMachine>`

Utility type to extract the caller-specific snapshot from a machine type. This is useful when working with the state in your components or actions.

Example usage:

```typescript
import { CallerSnapshotFrom } from "@actor-kit/types";
import { TodoMachine } from "./todo.machine";

type TodoSnapshot = CallerSnapshotFrom<TodoMachine>;

function TodoList({ snapshot }: { snapshot: TodoSnapshot }) {
  return (
    <ul>
      {snapshot.public.todos.map((todo) => (
        <li key={todo.id}>{todo.text}</li>
      ))}
    </ul>
  );
}
```

#### `ActorKitStateMachine`

Represents the structure of an Actor Kit state machine.

```typescript
type ActorKitStateMachine<
  TEvent extends BaseActorKitEvent & EventObject,
  TInput extends { id: string; caller: Caller },
  TPrivateProps extends { [key: string]: unknown },
  TPublicProps extends { [key: string]: unknown }
> = StateMachine<...>
```

Example usage:

```typescript
import { ActorKitStateMachine } from "@actor-kit/types";
import { setup } from "xstate";
import type {
  TodoEvent,
  TodoInput,
  TodoPrivateContext,
  TodoPublicContext,
} from "./todo.types";

export const todoMachine = setup({
  // ... machine setup
}).createMachine({
  // ... machine definition
}) satisfies ActorKitStateMachine<
  TodoEvent,
  TodoInput,
  TodoPrivateContext,
  TodoPublicContext
>;
```

### Other Types

- `ClientEventFrom<TMachine extends AnyActorKitStateMachine>`: Utility type to extract client events from an Actor Kit state machine.
- `ServiceEventFrom<TMachine extends AnyActorKitStateMachine>`: Utility type to extract service events from an Actor Kit state machine.

By including these types in your Actor Kit implementation, you ensure type safety and proper handling of events and state across your application.

## 🔐 Public and Private Data

Actor Kit supports the concepts of public and private data in the context. This allows you to manage shared data across all clients and caller-specific information securely.

## 📚 Storybook Integration

Actor Kit provides seamless integration with Storybook through the `withActorKit` decorator, allowing you to easily test and develop components that depend on actor state.

### Basic Usage

```typescript
import { withActorKit } from '@actor-kit/storybook';
import { GameContext } from './game.context';
import type { GameMachine } from './game.machine';

const meta = {
  title: 'Components/GameView',
  component: GameView,
  decorators: [
    withActorKit<GameMachine>({
      actorType: "game",
      context: GameContext,
    }),
  ],
};

export default meta;
type Story = StoryObj<typeof GameView>;

export const Default: Story = {
  parameters: {
    actorKit: {
      game: {
        "game-123": {
          public: {
            players: [],
            gameStatus: "idle"
          },
          private: {},
          value: "idle"
        }
      }
    }
  }
};
```

### Testing Patterns

There are two main patterns for testing with Actor Kit in Storybook:

#### 1. Static Stories (Using parameters.actorKit)

Best for simple stories that don't need state manipulation:

```typescript
export const Static: Story = {
  parameters: {
    actorKit: {
      game: {
        "game-123": {
          public: { /* initial state */ },
          private: {},
          value: "idle"
        }
      }
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Test UI state...
  }
};
```

#### 2. Interactive Stories (Using mount + direct client)

Better for stories that need to manipulate state:

```typescript
export const Interactive: Story = {
  play: async ({ canvasElement, mount }) => {
    const client = createActorKitMockClient<GameMachine>({
      initialSnapshot: {
        public: { /* initial state */ },
        private: {},
        value: "idle"
      }
    });

    await mount(
      <GameContext.ProviderFromClient client={client}>
        <GameView />
      </GameContext.ProviderFromClient>
    );

    // Now you can manipulate state
    client.produce((draft) => {
      draft.public.players.push({
        id: "player-1",
        name: "Player 1"
      });
    });
  }
};
```

### Multiple Actors

You can use multiple actors in a single story:

```typescript
const meta = {
  decorators: [
    withActorKit<SessionMachine>({
      actorType: "session",
      context: SessionContext,
    }),
    withActorKit<GameMachine>({
      actorType: "game",
      context: GameContext,
    }),
  ],
};

export const MultipleActors: Story = {
  parameters: {
    actorKit: {
      session: {
        "session-123": {
          public: { /* session state */ },
          private: {},
          value: "ready"
        }
      },
      game: {
        "game-123": {
          public: { /* game state */ },
          private: {},
          value: "active"
        }
      }
    }
  }
};
```

### Basic Event Spy Example

```typescript
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn } from "@storybook/test";
import { createActorKitMockClient } from "@actor-kit/test";
import { GameContext } from "./game.context";
import type { GameMachine } from "./game.machine";

export const JoinGame: Story = {
  play: async ({ canvasElement, mount }) => {
    const sendSpy = fn();
    const client = createActorKitMockClient<GameMachine>({
      initialSnapshot: {
        public: {
          players: [],
          gameStatus: "lobby"
        },
        private: {},
        value: "lobby"
      },
      onSend: sendSpy
    });

    await mount(
      <GameContext.ProviderFromClient client={client}>
        <JoinGameForm />
      </GameContext.ProviderFromClient>
    );

    // Find and fill the name input
    const nameInput = await canvas.findByLabelText("Player Name");
    await userEvent.type(nameInput, "Test Player");

    // Click the join button
    const joinButton = await canvas.findByText("Join Game");
    await userEvent.click(joinButton);

    // Verify the JOIN_GAME event was sent with correct payload
    expect(sendSpy).toHaveBeenCalledWith({
      type: "JOIN_GAME",
      playerName: "Test Player"
    });
  }
};
```

### Testing Multiple Events in Sequence

```typescript
export const GameRound: Story = {
  play: async ({ canvasElement, mount }) => {
    const sendSpy = fn();
    const client = createActorKitMockClient<GameMachine>({
      initialSnapshot: {
        public: {
          players: [
            { id: "player-1", name: "Player 1", score: 0 },
            { id: "player-2", name: "Player 2", score: 0 }
          ],
          currentQuestion: {
            text: "What is 2 + 2?",
            answer: "4"
          },
          gameStatus: "active"
        },
        private: {},
        value: { active: "questionActive" }
      },
      onSend: sendSpy
    });

    await mount(
      <GameContext.ProviderFromClient client={client}>
        <GameView />
      </GameContext.ProviderFromClient>
    );

    // Test buzzing in
    const buzzerButton = await canvas.findByText("Buzz In");
    await userEvent.click(buzzerButton);

    expect(sendSpy).toHaveBeenCalledWith({
      type: "BUZZ_IN",
      playerId: "player-1"
    });

    // Test submitting an answer
    const answerInput = await canvas.findByLabelText("Your Answer");
    await userEvent.type(answerInput, "4");
    
    const submitButton = await canvas.findByText("Submit Answer");
    await userEvent.click(submitButton);

    // Verify events were sent in order with correct payloads
    expect(sendSpy.mock.calls).toEqual([
      [{ type: "BUZZ_IN", playerId: "player-1" }],
      [{ type: "SUBMIT_ANSWER", answer: "4" }]
    ]);
  }
};
```

### Testing Complex Event Payloads

```typescript
export const GameConfiguration: Story = {
  play: async ({ canvasElement, mount }) => {
    const sendSpy = fn();
    const client = createActorKitMockClient<GameMachine>({
      initialSnapshot: {
        public: {
          gameStatus: "setup",
          config: {
            maxPlayers: 4,
            timeLimit: 30,
            categories: []
          }
        },
        private: {},
        value: "setup"
      },
      onSend: sendSpy
    });

    await mount(
      <GameContext.ProviderFromClient client={client}>
        <GameConfigForm />
      </GameContext.ProviderFromClient>
    );

    // Fill out configuration form
    await userEvent.selectOptions(
      await canvas.findByLabelText("Max Players"),
      "6"
    );
    
    await userEvent.selectOptions(
      await canvas.findByLabelText("Time Limit"),
      "60"
    );

    const categoryCheckboxes = await canvas.findAllByRole("checkbox");
    await userEvent.click(categoryCheckboxes[0]); // Select "History"
    await userEvent.click(categoryCheckboxes[2]); // Select "Science"

    const saveButton = await canvas.findByText("Save Configuration");
    await userEvent.click(saveButton);

    // Verify the UPDATE_CONFIG event was sent with the exact payload structure
    expect(sendSpy).toHaveBeenCalledWith({
      type: "UPDATE_CONFIG",
      config: {
        maxPlayers: 6,
        timeLimit: 60,
        categories: ["history", "science"]
      }
    });

    // You can also use partial matching for complex objects
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_CONFIG",
        config: expect.objectContaining({
          maxPlayers: 6,
          categories: expect.arrayContaining(["history", "science"])
        })
      })
    );
  }
};
```

### Testing Event Properties with Custom Matchers

```typescript
export const ChatMessage: Story = {
  play: async ({ canvasElement, mount }) => {
    const sendSpy = fn();
    const client = createActorKitMockClient<GameMachine>({
      initialSnapshot: {
        public: {
          messages: [],
          gameStatus: "active"
        },
        private: {},
        value: "active"
      },
      onSend: sendSpy
    });

    await mount(
      <GameContext.ProviderFromClient client={client}>
        <ChatBox />
      </GameContext.ProviderFromClient>
    );

    // Send a chat message
    const messageInput = await canvas.findByLabelText("Message");
    await userEvent.type(messageInput, "Hello, world!");
    
    const sendButton = await canvas.findByText("Send");
    await userEvent.click(sendButton);

    // Verify the SEND_MESSAGE event with timestamp
    expect(sendSpy).toHaveBeenCalledWith({
      type: "SEND_MESSAGE",
      text: "Hello, world!",
      timestamp: expect.any(Number),
      sender: expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String)
      })
    });

    // You can also create custom matchers for common patterns
    const isValidMessage = (event: any) => {
      return (
        event.type === "SEND_MESSAGE" &&
        typeof event.text === "string" &&
        typeof event.timestamp === "number" &&
        Date.now() - event.timestamp < 1000 // Message was sent within last second
      );
    };

    expect(sendSpy).toHaveBeenCalledWith(expect.custom(isValidMessage));
  }
};
```

## 📜 License

Actor Kit is [MIT licensed](LICENSE.md).

## 🔗 Related Technologies and Inspiration

Actor Kit builds upon and draws inspiration from several excellent technologies:

- [XState](https://xstate.js.org/): A powerful state management library for JavaScript and TypeScript applications.
- [Cloudflare Workers](https://workers.cloudflare.com/): A serverless platform for building and deploying applications at the edge.
- [Zod](https://zod.dev/): A TypeScript-first schema declaration and validation library.
- [PartyKit](https://www.partykit.io/): An inspiration for Actor Kit, providing real-time multiplayer infrastructure.
- [PartyServer](https://github.com/threepointone/partyserver/tree/main): PartyKit, for workers
- [xstate-migrate](https://github.com/jonmumm/xstate-migrate): A migration library for persisted XState machines, designed to facilitate state machine migrations when updating your XState configurations.

## 📄 Documentation

Detailed documentation lives in the [`docs/`](docs/) directory:

- [Architecture](docs/architecture.md) — system diagram, data flow, module boundaries, sync protocol
- [Testing Strategy](docs/testing-strategy.md) — seam boundaries, fakes, mutation testing, Storybook patterns
- [Roadmap](docs/roadmap/README.md) — improvement proposals with code examples and test plans
- [Architecture Decision Records](docs/adrs/) — key design decisions and rationale

## 🚧 Development Status

Actor Kit is under active development. Expect breaking changes between minor versions until 1.0. The API surface is stabilizing but not yet frozen.
