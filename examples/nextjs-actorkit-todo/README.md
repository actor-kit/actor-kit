# Next.js + Actor Kit Todo Example

This project demonstrates how to integrate Actor Kit with a Next.js application to create a real-time, event-driven todo list with owner-based access control.

Try it live: [https://nextjs-actor-kit-todo.vercel.app/](https://nextjs-actor-kit-todo.vercel.app/)

## 🌟 Key Features

- 🚀 Next.js app with Cloudflare Worker for Actor Kit backend
- 🔄 Real-time synchronization across clients
- 🖥️ Server-side rendering with Next.js
- 🎭 State management using XState and Actor Kit
- 🛡️ Type-safe interactions with TypeScript and Zod
- 🔐 Secure handling of public and private data
- 🔒 JWT-based authentication
- 👤 Owner-based access control demonstration

## 📁 Project Structure

```
examples/nextjs-actorkit-todo/
├── src/
│   ├── app/
│   │   ├── lists/
│   │   │   └── [id]/
│   │   │       ├── components.tsx  # Client-side todo list component
│   │   │       └── page.tsx        # Server-side rendering and data fetching
│   │   ├── layout.tsx              # Root layout with UserProvider
│   │   ├── page.tsx                # Home page with "New List" button
│   │   └── user-context.tsx        # User context provider
│   ├── middleware.ts               # Next.js middleware for authentication
│   ├── server.ts                   # Cloudflare Worker setup with Actor Kit router
│   ├── session.ts                  # Utility for getting user ID
│   ├── todo.components.tsx         # Shared todo list component
│   ├── todo.context.tsx            # Actor Kit context for todos
│   ├── todo.machine.ts             # Todo state machine definition
│   ├── todo.schemas.ts             # Zod schemas for event validation
│   ├── todo.server.ts              # Actor Kit server setup
│   └── todo.types.ts               # TypeScript types for events and state
├── package.json                    # Project dependencies and scripts
├── wrangler.toml                   # Cloudflare Workers configuration
└── README.md                       # Project documentation
```

## 🛠️ How It Works

### 1. Todo Server Setup

The `src/todo.server.ts` file creates the Todo server using Actor Kit:

```typescript
import { createMachineServer } from "actor-kit/worker";
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

This setup:

- Creates a machine server for the Todo list
- Defines client and service event schemas, as well as input props schema
- Enables persistence for the Todo state

### 2. Cloudflare Worker Setup

The `src/server.ts` file sets up the Cloudflare Worker with Actor Kit:

```typescript
import { DurableObjectNamespace } from "@cloudflare/workers-types";
import { AnyActorServer } from "actor-kit";
import { createActorKitRouter } from "actor-kit/worker";
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

### 3. Server-Side Integration

The todo list page (`src/app/lists/[id]/page.tsx`) fetches initial state and sets up the Actor Kit context:

```typescript
import { getUserId } from "@/session";
import { createAccessToken, createActorFetch } from "actor-kit/server";
import { TodoActorKitProvider } from "../../../todo.context";
import type { TodoMachine } from "../../../todo.machine";
import { TodoList } from "./components";

const host = process.env.ACTOR_KIT_HOST!;
const signingKey = process.env.ACTOR_KIT_SECRET!;

const fetchTodoActor = createActorFetch<TodoMachine>({
  actorType: "todo",
  host,
});

export default async function TodoPage(props: { params: { id: string } }) {
  const listId = props.params.id;
  const userId = await getUserId();

  const accessToken = await createAccessToken({
    signingKey,
    actorId: listId,
    actorType: "todo",
    callerId: userId,
    callerType: "client",
  });

  const payload = await fetchTodoActor({
    actorId: listId,
    accessToken,
    input: {
      initialTodos: [], // You can pass initial todos here if needed
    },
  });

  return (
    <TodoActorKitProvider
      host={host}
      actorId={listId}
      accessToken={accessToken}
      checksum={payload.checksum}
      initialSnapshot={payload.snapshot}
    >
      <TodoList />
    </TodoActorKitProvider>
  );
}
```

### 4. Client-Side Component

The `TodoList` component (`src/app/lists/[id]/components.tsx`) demonstrates an example of access control and how to use the `send` function to dispatch events:

```typescript
export function TodoList() {
  const todos = TodoActorKitContext.useSelector((state) => state.public.todos);
  const send = TodoActorKitContext.useSend();
  const [newTodoText, setNewTodoText] = useState("");

  const userId = useContext(UserContext);
  const ownerId = TodoActorKitContext.useSelector(
    (state) => state.public.ownerId
  );
  const isOwner = ownerId === userId;

  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTodoText.trim()) {
      send({ type: "ADD_TODO", text: newTodoText.trim() });
      setNewTodoText("");
    }
  };

  const handleToggleTodo = (id: string) => {
    send({ type: "TOGGLE_TODO", id });
  };

  const handleDeleteTodo = (id: string) => {
    send({ type: "DELETE_TODO", id });
  };

  return (
    <div>
      <h1>Todo List</h1>
      {isOwner && <form onSubmit={handleAddTodo}>{/* Add todo form */}</form>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <span>{todo.text}</span>
            <button onClick={() => handleToggleTodo(todo.id)}>
              {todo.completed ? "Undo" : "Complete"}
            </button>
            <button onClick={() => handleDeleteTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

In this component:

1. We use `TodoActorKitContext.useSend()` to get the `send` function, which allows us to dispatch events to the Actor Kit state machine.
2. The `handleAddTodo` function demonstrates how to send an `ADD_TODO` event with a payload containing the new todo text.
3. The `handleToggleTodo` function shows how to send a `TOGGLE_TODO` event with the todo's id.
4. The `handleDeleteTodo` function illustrates sending a `DELETE_TODO` event with the todo's id.

These events are defined in the todo state machine and processed accordingly, updating the state and triggering real-time updates across all connected clients.

## 🚀 Getting Started

1. Clone the repository and navigate to the example directory:

   ```bash
   git clone https://github.com/jonmumm/actor-kit.git
   cd actor-kit/examples/nextjs-actorkit-todo
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up environment variables:

   Create a `.env.local` file in the root of your project:

   ```bash
   cp .env.local.example .env.local
   ```

   Edit `.env.local` and set the following variables:

   ```
   ACTOR_KIT_HOST=127.0.0.1:8787
   ACTOR_KIT_SECRET=your-secret-key
   ```

   Replace `your-secret-key` with a secure, randomly generated secret.

   The local Cloudflare Worker uses the same host and secret during development via the example's Wrangler config and dev scripts, so you do not need a separate `.dev.vars` file for local setup.

4. Start the development server:

   In one terminal, start the Next.js development server:

   ```bash
   npm run dev
   ```

   In another terminal, start the Cloudflare Worker:

   ```bash
   npm run dev-api
   ```

5. Open `http://localhost:3000` in your browser to view the application.

## 🚀 Deployment

To deploy the API as a Cloudflare Worker:

1. Set up secrets for the Cloudflare Worker:

   ```bash
   npx wrangler secret put ACTOR_KIT_SECRET
   ```

   Enter the same secret key you used in your local `.env.local` file.

2. Deploy the Cloudflare Worker:

   ```bash
   npx wrangler deploy
   ```

3. Update your production Next.js environment:

   In your production environment (e.g., Vercel), set the following environment variables:

   ```
   ACTOR_KIT_HOST=your-worker-name.your-account.workers.dev
   ACTOR_KIT_SECRET=your-secret-key
   ```

   Replace `your-worker-name.your-account.workers.dev` with your actual Cloudflare Worker URL, and use the same `your-secret-key` as before.

Visit the deployed application at [https://nextjs-actorkit-todo.vercel.app/](https://nextjs-actorkit-todo.vercel.app/)
