import type { ActorKitEnv } from "@actor-kit/types";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { TodoServer } from "./todo.server";

export interface ActorEnv extends ActorKitEnv {
  TODO: DurableObjectNamespace<TodoServer>;
}
