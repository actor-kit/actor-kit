import { z } from "zod";
import { array, boolean, schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker";

// --- Types ---
type Todo = { id: string; text: string; done: boolean };
type TodoState = {
  todos: Todo[];
  ownerId: string;
  memberIds: string[];
};

// --- Schemas ---
const TodoItemSchema = schema({ id: string, text: string, done: boolean });
const OwnerViewSchema = schema({
  todos: array(TodoItemSchema),
  memberCount: uint32,
});
const ViewerViewSchema = schema({
  todoCount: uint32,
  doneCount: uint32,
});

// --- Actor ---
export const TodoListContract = defineActor("todo-list", {
  input: z.object({ creator: z.string() }),
  init: (input: { creator: string }): TodoState => ({
    todos: [],
    ownerId: input.creator,
    memberIds: [],
  }),

  roles: {
    owner: (state: TodoState, caller: string) => caller === state.ownerId,
    member: (state: TodoState, caller: string) => state.memberIds.includes(caller),
    viewer: () => true,
  },

  messages: {
    ADD_TODO: message(
      z.object({ text: z.string().min(1).max(200) }),
      {
        guard: (_state: TodoState, _payload: { text: string }, ctx: { role: string }) =>
          ctx.role === "owner" || ctx.role === "member",
        handler: (state: TodoState, { text }) => ({
          ...state,
          todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
        }),
      },
    ),
    TOGGLE: message(
      z.object({ id: z.string() }),
      {
        guard: (_state: TodoState, _payload: { id: string }, ctx: { role: string }) =>
          ctx.role === "owner" || ctx.role === "member",
        handler: (state: TodoState, { id }) => ({
          ...state,
          todos: state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
        }),
      },
    ),
    DELETE_TODO: message(
      z.object({ id: z.string() }),
      {
        guard: (_state: TodoState, _payload: { id: string }, ctx: { role: string }) =>
          ctx.role === "owner",
        handler: (state: TodoState, { id }) => ({
          ...state,
          todos: state.todos.filter((t) => t.id !== id),
        }),
      },
    ),
    INVITE: message(
      z.object({ userId: z.string() }),
      {
        guard: (_state: TodoState, _payload: { userId: string }, ctx: { role: string }) =>
          ctx.role === "owner",
        handler: (state: TodoState, { userId }) => ({
          ...state,
          memberIds: [...state.memberIds, userId],
        }),
      },
    ),
  },

  views: {
    owner: view.shared(OwnerViewSchema, (state: TodoState) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    member: view.shared(OwnerViewSchema, (state: TodoState) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    viewer: view.shared(ViewerViewSchema, (state: TodoState) => ({
      todoCount: state.todos.length,
      doneCount: state.todos.filter((t) => t.done).length,
    })),
  },
});

export type TodoListContract = typeof TodoListContract;
