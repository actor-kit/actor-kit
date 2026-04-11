// React context with typed hooks, derived from the todo-list contract.
// Browser-safe: todo.ts imports from @actor-kit/worker/testing (no cloudflare:workers).

import { actorContext } from "@actor-kit/react";
import { TodoListContract } from "./todo";

export const TodoListContext = actorContext(TodoListContract);
