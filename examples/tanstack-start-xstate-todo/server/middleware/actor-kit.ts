import { getActorRuntimeEnv } from "../../src/server-env";
import { todoActorRouter } from "../../src/todo.server";

type MiddlewareEvent = {
  req: Request;
};

export default function actorKitMiddleware(event: MiddlewareEvent) {
  const url = new URL(event.req.url);

  if (url.pathname === "/health") {
    return new Response("ok");
  }

  if (!url.pathname.startsWith("/api/")) {
    return undefined;
  }

  return todoActorRouter(event.req, getActorRuntimeEnv());
}
