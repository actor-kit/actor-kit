import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { createAccessToken, createActorFetch } from "@actor-kit/server";
import type { Caller } from "@actor-kit/types";
import { z } from "zod";
import { TodoActorKitProvider } from "../todo.context";
import type { TodoMachine } from "../todo.machine";
import { TodoList } from "../components/TodoList";
import { getServerEnv, tryGetActorRuntimeEnv } from "../server-env";

const ListRouteInputSchema = z.object({
  listId: z.string().min(1),
});

const loadTodoRoute = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => ListRouteInputSchema.parse(input))
  .handler(async ({ data }) => {
    const env = getServerEnv();
    const caller: Caller = {
      id: "demo-user",
      type: "client",
    };
    const accessToken = await createAccessToken({
      signingKey: env.ACTOR_KIT_SECRET,
      actorId: data.listId,
      actorType: "todo",
      callerId: caller.id,
      callerType: caller.type,
    });
    const runtimeEnv = tryGetActorRuntimeEnv();

    const payload = runtimeEnv
      ? await getTodoSnapshotFromRuntimeEnv(runtimeEnv, data.listId, caller)
      : await getTodoSnapshotFromHost(env.ACTOR_KIT_HOST, data.listId, accessToken);

    return {
      accessToken,
      host: env.ACTOR_KIT_HOST,
      listId: data.listId,
      payload,
      userId: caller.id,
    };
  });

async function getTodoSnapshotFromHost(
  host: string,
  listId: string,
  accessToken: string
) {
  const fetchTodoActor = createActorFetch<TodoMachine>({
    actorType: "todo",
    host,
  });

  return fetchTodoActor({
    actorId: listId,
    accessToken,
  });
}

async function getTodoSnapshotFromRuntimeEnv(
  runtimeEnv: NonNullable<ReturnType<typeof tryGetActorRuntimeEnv>>,
  listId: string,
  caller: Caller
) {
  const durableObjectId = runtimeEnv.TODO.idFromName(listId);
  const durableObject = runtimeEnv.TODO.get(durableObjectId) as {
    spawn: (props: {
      actorType: string;
      actorId: string;
      caller: Caller;
      input: Record<string, unknown>;
    }) => Promise<void>;
    getSnapshot: (caller: Caller) => Promise<{
      snapshot: Awaited<
        ReturnType<ReturnType<typeof createActorFetch<TodoMachine>>>
      >["snapshot"];
      checksum: string;
    }>;
  };

  await durableObject.spawn({
    actorType: "todo",
    actorId: listId,
    caller,
    input: {},
  });

  return durableObject.getSnapshot(caller);
}

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
