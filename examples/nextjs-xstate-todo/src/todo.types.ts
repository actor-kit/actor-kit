import { z } from "zod";
import {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";
import { Env } from "./types";

// Inline types for XState event augmentation
type Caller = { type: "client" | "service" | "system"; id: string };

type BaseActorKitEvent<TEnv> = {
  caller: Caller;
  env: TEnv;
};

type WithActorKitEvent<
  T extends { type: string },
  C extends string,
> = T &
  BaseActorKitEvent<Env> & { caller: { type: C } };

type ActorKitSystemEvent =
  | { type: "INITIALIZE"; caller: { type: "system"; id: string } }
  | { type: "CONNECT"; caller: { type: "system"; id: string } }
  | { type: "DISCONNECT"; caller: { type: "system"; id: string } }
  | { type: "RESUME"; caller: { type: "system"; id: string } };

type WithActorKitInput<TProps, TEnv> = TProps & {
  id: string;
  caller: Caller;
  env: TEnv;
};

export type TodoClientEvent = z.infer<typeof TodoClientEventSchema>;
export type TodoServiceEvent = z.infer<typeof TodoServiceEventSchema>;
export type TodoInputProps = z.infer<typeof TodoInputPropsSchema>;

export type TodoEvent = (
  | WithActorKitEvent<TodoClientEvent, "client">
  | WithActorKitEvent<TodoServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<Env>;

export type TodoInput = WithActorKitInput<TodoInputProps, Env>;

export type TodoPrivateContext = {
  lastAccessTime?: number;
  userPreferences?: {
    theme: "light" | "dark";
    sortOrder: "asc" | "desc";
  };
};

export type TodoPublicContext = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  lastSync: number | null;
};

export type TodoServerContext = {
  public: TodoPublicContext;
  private: Record<string, TodoPrivateContext>;
};
