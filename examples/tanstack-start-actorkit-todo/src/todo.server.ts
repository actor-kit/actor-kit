import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createActorKitRouter, createMachineServer } from "actor-kit/worker";
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

export const todoActorRouter = createActorKitRouter<WorkerEnv>(["todo"]);
