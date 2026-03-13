import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createActorKitRouter } from "actor-kit/worker";
import { createMachineServer } from "actor-kit/worker";
import { todoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";
import type { ActorEnv } from "./actor-env";

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

interface WorkerEnv extends ActorEnv {
  TODO: DurableObjectNamespace<TodoServer>;
}

const router = createActorKitRouter<WorkerEnv>(["todo"]);

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return router(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
