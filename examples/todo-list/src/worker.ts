// Cloudflare Worker entry — exports the TodoList Durable Object class.
// Nitro merges this with its server handler for the final Worker module.

import { createActorClass } from "@actor-kit/worker";
import { TodoListContract } from "./todo";

export const TodoList = createActorClass(TodoListContract);
