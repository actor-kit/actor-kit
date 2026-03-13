import type { ActorKitStateMachine } from "actor-kit";
import { assign, setup } from "xstate";
import type { TodoEvent, TodoInput, TodoServerContext } from "./todo.types";

export const todoMachine = setup({
  types: {
    context: {} as TodoServerContext,
    events: {} as TodoEvent,
    input: {} as TodoInput,
  },
  actions: {
    addTodo: assign({
      public: ({ context, event }) => {
        if (event.type !== "ADD_TODO") return context.public;
        return {
          ...context.public,
          todos: [
            ...context.public.todos,
            { id: crypto.randomUUID(), text: event.text, completed: false },
          ],
          lastSync: new Date().getTime(),
        };
      },
    }),
    toggleTodo: assign({
      public: ({ context, event }) => {
        if (event.type !== "TOGGLE_TODO") return context.public;
        return {
          ...context.public,
          todos: context.public.todos.map((todo) =>
            todo.id === event.id
              ? { ...todo, completed: !todo.completed }
              : todo
          ),
          lastSync: Date.now(),
        };
      },
    }),
    deleteTodo: assign({
      public: ({ context, event }) => {
        if (event.type !== "DELETE_TODO") return context.public;
        return {
          ...context.public,
          todos: context.public.todos.filter((todo) => todo.id !== event.id),
          lastSync: Date.now(),
        };
      },
    }),
  },
  guards: {
    isOwner: ({ context, event }) => event.caller.id === context.public.ownerId,
  },
}).createMachine({
  id: "todo",
  type: "parallel",
  context: ({ input }: { input: TodoInput }) => ({
    public: {
      ownerId: input.caller.id,
      todos: [],
      lastSync: null,
    },
    private: {},
  }),
  states: {
    Initialization: {
      initial: "Ready",
      states: {
        Ready: {},
      },
    },
    TodoManagement: {
      on: {
        ADD_TODO: {
          actions: ["addTodo"],
          guard: "isOwner",
        },
        TOGGLE_TODO: {
          actions: ["toggleTodo"],
          guard: "isOwner",
        },
        DELETE_TODO: {
          actions: ["deleteTodo"],
          guard: "isOwner",
        },
      },
    },
  },
}) satisfies ActorKitStateMachine<TodoEvent, TodoInput, TodoServerContext>;

export type TodoMachine = typeof todoMachine;
export default TodoMachine;
