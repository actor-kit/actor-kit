import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { TodoListContext } from "../todo.context";
import { TodoOwner } from "../components/TodoOwner";
import { TodoViewer } from "../components/TodoViewer";
import { getActorRuntimeEnv } from "../server-env";

const TodoRouteInputSchema = z.object({
  listId: z.string().min(1),
});

// Owner/member view shape
const OwnerSnapshotSchema = z.object({
  todos: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })),
  memberCount: z.number(),
});

// Viewer view shape
const ViewerSnapshotSchema = z.object({
  todoCount: z.number(),
  doneCount: z.number(),
});

// Discriminated snapshot: shape depends on role
type OwnerSnapshot = z.infer<typeof OwnerSnapshotSchema>;
type ViewerSnapshot = z.infer<typeof ViewerSnapshotSchema>;

type LoaderData =
  | { listId: string; role: "owner"; snapshot: OwnerSnapshot }
  | { listId: string; role: "member"; snapshot: OwnerSnapshot }
  | { listId: string; role: "viewer"; snapshot: ViewerSnapshot };

const RoleSchema = z.enum(["owner", "member", "viewer"]);

// Server function: fetch initial snapshot from the Durable Object.
// Uses the REAL callerId (from cookie) so the DO returns the correct role-based view.
const loadTodoList = createServerFn({ method: "GET" })
  .validator(TodoRouteInputSchema)
  .handler(async ({ data }): Promise<LoaderData> => {
    const env = getActorRuntimeEnv();
    const listId = data.listId;

    const doId = env.TODO_LIST.idFromName(listId);
    const stub = env.TODO_LIST.get(doId);

    // Read caller from cookie — must match the identity used for WebSocket.
    // Mint + persist one on first visit so the WS upgrade (and every later
    // request) presents the same identity. Demo-only: production would use a
    // signed session cookie or JWT.
    const existingCallerId = getCookie("caller_id");
    const callerId = existingCallerId ?? `user-${crypto.randomUUID().slice(0, 8)}`;
    if (existingCallerId === undefined) {
      setCookie("caller_id", callerId, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
    }

    // Spawn with creator — first visitor becomes the owner
    await stub.spawn({
      actorId: listId,
      caller: callerId,
      callerType: "user",
      input: { creator: callerId },
    });

    // Get snapshot with real caller for correct role-based view
    const result = await stub.getSnapshot(callerId, "user");
    const role = RoleSchema.parse(result.role);

    switch (role) {
      case "owner":
      case "member":
        return { listId, role, snapshot: OwnerSnapshotSchema.parse(result.snapshot) };
      case "viewer":
        return { listId, role, snapshot: ViewerSnapshotSchema.parse(result.snapshot) };
    }
  });

export const Route = createFileRoute("/todo/$listId")({
  loader: ({ params }) => loadTodoList({ data: params }),
  component: TodoRouteComponent,
});

function TodoRouteComponent() {
  const loaderData = Route.useLoaderData();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="mx-auto flex w-full max-w-lg flex-col items-center gap-6 rounded-3xl bg-white p-10 shadow-sm">
        <div className="flex w-full items-center justify-between">
          <p className="text-sm font-medium uppercase tracking-wider text-[var(--sea-ink-soft)]">
            Live Todo List
          </p>
          <Link
            to="/"
            className="text-sm font-medium text-[var(--lagoon-deep)] hover:underline"
          >
            Home
          </Link>
        </div>
        <TodoListLive loaderData={loaderData} />
      </section>
    </main>
  );
}

// Client component: creates a WebSocket client via useClient() and provides it
// through the typed context. The SSR snapshot is the initial view until the
// WebSocket delivers live state.
function TodoListLive({ loaderData }: { loaderData: LoaderData }) {
  const client = TodoListContext.useClient({
    path: `/api/todo-list/${loaderData.listId}`,
    initialView:
      loaderData.role === "viewer"
        ? { role: loaderData.role, ...loaderData.snapshot }
        : loaderData.role === "owner"
          ? { role: loaderData.role, ...loaderData.snapshot }
          : { role: loaderData.role, ...loaderData.snapshot },
  });

  return (
    <TodoListContext.Provider client={client}>
      <TodoListWithHooks />
    </TodoListContext.Provider>
  );
}

// Reads live state from the actor client via typed hooks.
// Branches on role — owner/member get a full todo list, viewer gets counts.
function TodoListWithHooks() {
  const view = TodoListContext.useView();
  const send = TodoListContext.useSend();
  const role = TodoListContext.useRole();

  if (role === "viewer") {
    const viewerView = view as unknown as ViewerSnapshot;
    return <TodoViewer todoCount={viewerView.todoCount} doneCount={viewerView.doneCount} role="viewer" />;
  }

  const ownerView = view as unknown as OwnerSnapshot;
  return (
    <TodoOwner
      todos={ownerView.todos}
      memberCount={ownerView.memberCount}
      canDelete={role === "owner"}
      role={role ?? "member"}
      onAdd={(text) => send({ type: "ADD_TODO", text })}
      onToggle={(id) => send({ type: "TOGGLE", id })}
      onDelete={(id) => send({ type: "DELETE_TODO", id })}
    />
  );
}
