import { z } from "zod";
import { array, boolean, schema, string, uint32, view } from "@actor-kit/core";
import { actor, message } from "@actor-kit/worker";

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

// --- Shared message handlers ---
const addTodo = message(
  z.object({ text: z.string().min(1).max(200) }),
  (state: TodoState, { text }, { caller }) => ({
    ...state,
    todos: [...state.todos, { id: crypto.randomUUID(), text, done: false }],
  }),
);

const toggleTodo = message(
  z.object({ id: z.string() }),
  (state: TodoState, { id }) => ({
    ...state,
    todos: state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
  }),
);

// --- Owner-only handlers ---
const deleteTodo = message(
  z.object({ id: z.string() }),
  (state: TodoState, { id }) => ({
    ...state,
    todos: state.todos.filter((t) => t.id !== id),
  }),
);

const invite = message(
  z.object({ userId: z.string() }),
  (state: TodoState, { userId }) => ({
    ...state,
    memberIds: [...state.memberIds, userId],
  }),
);

// --- Actor ---
export const TodoList = actor("todo-list", {
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
    owner: { ADD_TODO: addTodo, TOGGLE: toggleTodo, DELETE_TODO: deleteTodo, INVITE: invite },
    member: { ADD_TODO: addTodo, TOGGLE: toggleTodo },
    viewer: {}, // read-only
  },

  views: {
    owner: view(OwnerViewSchema, (state: TodoState) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    member: view(OwnerViewSchema, (state: TodoState) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    viewer: view(ViewerViewSchema, (state: TodoState) => ({
      todoCount: state.todos.length,
      doneCount: state.todos.filter((t) => t.done).length,
    })),
  },
});
