import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createDurableActor } from "@actor-kit/core";
import { fromXStateMachine } from "@actor-kit/xstate";
import { createActorKitRouter } from "@actor-kit/worker";
import type { CallerSnapshotFrom } from "@actor-kit/types";
import { todoMachine, type TodoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";
import type { ActorEnv } from "./actor-env";

type TodoView = CallerSnapshotFrom<TodoMachine>;

const logic = fromXStateMachine<typeof todoMachine, TodoView>(todoMachine, {
  getView: (snapshot, caller) => ({
    public: snapshot.context.public,
    private: snapshot.context.private[caller.id] ?? {},
    value: snapshot.value,
  }),
});

export const Todo = createDurableActor({
  logic,
  events: {
    client: TodoClientEventSchema,
    service: TodoServiceEventSchema,
  },
  input: TodoInputPropsSchema,
  persisted: true,
});

export type TodoServer = InstanceType<typeof Todo>;

interface WorkerEnv extends ActorEnv {
  TODO: DurableObjectNamespace<TodoServer>;
}

export const todoActorRouter = createActorKitRouter<WorkerEnv>(["todo"]);
