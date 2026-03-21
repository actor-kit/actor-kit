import { createDurableActor } from "@actor-kit/core";
import { fromXStateMachine } from "@actor-kit/xstate";
import { todoMachine } from "./todo.machine";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";

const logic = fromXStateMachine(todoMachine, {
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
