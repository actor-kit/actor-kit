"use client";

import { createActorKitContext } from "actor-kit/react";
import type { TodoMachine } from "./todo.machine";

export const TodoActorKitContext = createActorKitContext<TodoMachine>("todo");
export const TodoActorKitProvider = TodoActorKitContext.Provider;
