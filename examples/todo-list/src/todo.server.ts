import { createActorClass } from "@actor-kit/worker";
import { TodoListContract } from "./todo.contract";

export const TodoList = createActorClass(TodoListContract);
