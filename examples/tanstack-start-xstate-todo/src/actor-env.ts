import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { TodoServer } from "./todo.server";

export interface ActorEnv {
  ACTOR_KIT_SECRET: string;
  TODO: DurableObjectNamespace<TodoServer>;
  [key: string]: unknown;
}
