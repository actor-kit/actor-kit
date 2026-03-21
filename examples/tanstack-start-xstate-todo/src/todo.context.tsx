"use client";

import { createActorKitContext } from "@actor-kit/react";
import type { TodoView, TodoClientEvent } from "./todo.types";

export const TodoActorKitContext = createActorKitContext<TodoView, TodoClientEvent>("todo");
export const TodoActorKitProvider = TodoActorKitContext.Provider;
