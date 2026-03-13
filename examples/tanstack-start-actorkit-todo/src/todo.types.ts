import type {
  ActorKitSystemEvent,
  BaseActorKitEvent,
  WithActorKitEvent,
  WithActorKitInput,
} from "actor-kit";
import type { z } from "zod";
import type { ActorEnv } from "./actor-env";
import type {
  TodoClientEventSchema,
  TodoInputPropsSchema,
  TodoServiceEventSchema,
} from "./todo.schemas";

export type TodoClientEvent = z.infer<typeof TodoClientEventSchema>;
export type TodoServiceEvent = z.infer<typeof TodoServiceEventSchema>;
export type TodoInputProps = z.infer<typeof TodoInputPropsSchema>;

export type TodoEvent = (
  | WithActorKitEvent<TodoClientEvent, "client">
  | WithActorKitEvent<TodoServiceEvent, "service">
  | ActorKitSystemEvent
) &
  BaseActorKitEvent<ActorEnv>;

export type TodoInput = WithActorKitInput<TodoInputProps, ActorEnv>;

export type TodoPrivateContext = Record<string, never>;

export type TodoPublicContext = {
  ownerId: string;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  lastSync: number | null;
};

export type TodoServerContext = {
  public: TodoPublicContext;
  private: Record<string, TodoPrivateContext>;
};
