export { Todo } from "./app/todo.server";
export { Session } from "./app/session.server";
export { Remix } from "./app/remix.server";

import { logDevReady } from "@remix-run/cloudflare";
import * as build from "@remix-run/dev/server-build";
import { createActorKitRouter } from "actor-kit/worker";
import { WorkerEntrypoint } from "cloudflare:workers";

if (process.env.NODE_ENV === "development") {
  logDevReady(build);
}

const router = createActorKitRouter<Env>(["todo", "session"]);

export default class Worker extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname === "/health") {
      return new Response("ok");
    }
    if (request.url.includes("/api/")) {
      return router(request, this.env, this.ctx);
    }

    const id = this.env.REMIX.idFromName("default");
    return this.env.REMIX.get(id).fetch(request);
  }
}
