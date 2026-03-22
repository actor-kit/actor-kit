import { createDurableActor } from "@actor-kit/core";
import { fromXStateMachine } from "@actor-kit/xstate";
import { todoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";
import type { TodoView } from "./todo.types";

const logic = fromXStateMachine<typeof todoMachine, TodoView>(todoMachine, {
  getView: (snapshot, _caller) => ({
    todos: snapshot.context.public.todos,
    ownerId: snapshot.context.public.ownerId,
    lastSync: snapshot.context.public.lastSync,
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
export default Todo;
