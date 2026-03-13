import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createAccessToken, createActorFetch } from "actor-kit/server";
import { z } from "zod";
import { TodoActorKitProvider } from "../todo.context";
import type { TodoMachine } from "../todo.machine";
import { TodoList } from "../components/TodoList";
import { getServerEnv } from "../server-env";

const ListRouteInputSchema = z.object({
  listId: z.string().min(1),
});

const loadTodoRoute = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => ListRouteInputSchema.parse(input))
  .handler(async ({ data }) => {
    const env = getServerEnv();
    const fetchTodoActor = createActorFetch<TodoMachine>({
      actorType: "todo",
      host: env.ACTOR_KIT_HOST,
    });
    const accessToken = await createAccessToken({
      signingKey: env.ACTOR_KIT_SECRET,
      actorId: data.listId,
      actorType: "todo",
      callerId: "demo-user",
      callerType: "client",
    });

    const payload = await fetchTodoActor({
      actorId: data.listId,
      accessToken,
    });

    return {
      accessToken,
      host: env.ACTOR_KIT_HOST,
      listId: data.listId,
      payload,
      userId: "demo-user",
    };
  });

export const Route = createFileRoute("/lists/$listId")({
  loader: async ({ params }) => loadTodoRoute({ data: params }),
  component: TodoRouteComponent,
});

function TodoRouteComponent() {
  const { accessToken, host, listId, payload, userId } =
    Route.useLoaderData();

  return (
    <main className="page-wrap px-4 py-10">
      <section className="island-shell mx-auto max-w-3xl rounded-[2rem] px-8 py-10">
        <TodoActorKitProvider
          host={host}
          actorId={listId}
          accessToken={accessToken}
          checksum={payload.checksum}
          initialSnapshot={payload.snapshot}
        >
          <TodoList userId={userId} />
        </TodoActorKitProvider>
      </section>
    </main>
  );
}
