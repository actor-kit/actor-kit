import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, useLoaderData } from "@remix-run/react";
import { createAccessToken, createActorFetch } from "actor-kit/server";
import { TodoList } from "../components";
import { TodoProvider } from "../todo.context";
import type { TodoMachine } from "../todo.machine";

export async function loader({ params, context }: LoaderFunctionArgs) {
  const fetchTodoActor = createActorFetch<TodoMachine>({
    actorType: "todo",
    host: context.env.ACTOR_KIT_HOST,
  });

  const listId = params.id;
  if (!listId) {
    throw new Error("listId is required");
  }

  const accessToken = await createAccessToken({
    signingKey: context.env.ACTOR_KIT_SECRET,
    actorId: listId,
    actorType: "todo",
    callerId: context.userId,
    callerType: "client",
  });
  const payload = await fetchTodoActor({
    actorId: listId,
    accessToken,
  });
  return json({
    listId,
    accessToken,
    payload,
    host: context.env.ACTOR_KIT_HOST,
  });
}

export default function ListPage() {
  const { listId, accessToken, payload, host } = useLoaderData<typeof loader>();

  return (
    <TodoProvider
      host={host}
      actorId={listId}
      accessToken={accessToken}
      checksum={payload.checksum}
      initialSnapshot={payload.snapshot}
    >
      <TodoList />
    </TodoProvider>
  );
}
