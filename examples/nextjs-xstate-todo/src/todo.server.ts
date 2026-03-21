import { createDurableActor } from "@actor-kit/core";
import { fromXStateMachine } from "@actor-kit/xstate";
import type { CallerSnapshotFrom } from "@actor-kit/types";
import { todoMachine, type TodoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";

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
export default Todo;
