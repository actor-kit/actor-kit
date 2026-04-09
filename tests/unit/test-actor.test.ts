import { array, boolean, schema, string, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Define a Todo actor for testing ---

const TodoItem = schema({ id: string, text: string, done: boolean });
const OwnerView = schema({ todos: array(TodoItem), memberCount: uint32 });
const ViewerView = schema({ todoCount: uint32, doneCount: uint32 });

type Todo = { id: string; text: string; done: boolean };
type State = {
  todos: Todo[];
  ownerId: string;
  memberIds: string[];
};

const addTodo = message(z.object({ text: z.string().min(1) }), (state: State, { text }) => ({
  ...state,
  todos: [...state.todos, { id: `todo-${state.todos.length + 1}`, text, done: false }],
}));

const toggle = message(z.object({ id: z.string() }), (state: State, { id }) => ({
  ...state,
  todos: state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
}));

const deleteTodo = message(z.object({ id: z.string() }), (state: State, { id }) => ({
  ...state,
  todos: state.todos.filter((t) => t.id !== id),
}));

const invite = message(z.object({ userId: z.string() }), (state: State, { userId }) => ({
  ...state,
  memberIds: [...state.memberIds, userId],
}));

const todoActorDef = {
  input: z.object({ creator: z.string() }),
  init: (input: { creator: string }) => ({
    todos: [] as Todo[],
    ownerId: input.creator,
    memberIds: [] as string[],
  }),
  roles: {
    owner: (state: State, caller: string) => caller === state.ownerId,
    member: (state: State, caller: string) => state.memberIds.includes(caller),
    viewer: () => true,
  },
  messages: {
    owner: { ADD_TODO: addTodo, TOGGLE: toggle, DELETE_TODO: deleteTodo, INVITE: invite },
    member: { ADD_TODO: addTodo, TOGGLE: toggle },
    viewer: {},
  },
  views: {
    owner: view(OwnerView, (state: State) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    member: view(OwnerView, (state: State) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    })),
    viewer: view(ViewerView, (state: State) => ({
      todoCount: state.todos.length,
      doneCount: state.todos.filter((t) => t.done).length,
    })),
  },
};

// --- Tests ---

describe("testActor()", () => {
  const t = testActor(todoActorDef);

  describe("init", () => {
    it("initializes state from input", () => {
      const state = t.init({ creator: "alice" });
      expect(state.todos).toEqual([]);
      expect(state.ownerId).toBe("alice");
      expect(state.memberIds).toEqual([]);
    });

    it("rejects invalid input", () => {
      expect(() => t.init({} as { creator: string })).toThrow();
    });
  });

  describe("role", () => {
    it("resolves owner role for creator", () => {
      const state = t.init({ creator: "alice" });
      expect(t.role(state, "alice")).toBe("owner");
    });

    it("resolves viewer role for unknown caller", () => {
      const state = t.init({ creator: "alice" });
      expect(t.role(state, "stranger")).toBe("viewer");
    });

    it("resolves member role after invite", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "INVITE", userId: "bob" });
      expect(t.role(state, "bob")).toBe("member");
    });
  });

  describe("send", () => {
    it("owner can add todo", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "ADD_TODO", text: "Buy milk" });
      expect(state.todos).toHaveLength(1);
      expect(state.todos[0]?.text).toBe("Buy milk");
    });

    it("member can add todo after being invited", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "INVITE", userId: "bob" });
      state = await t.send(state, "bob", { type: "ADD_TODO", text: "From Bob" });
      expect(state.todos).toHaveLength(1);
      expect(state.todos[0]?.text).toBe("From Bob");
    });

    it("viewer cannot send messages (empty message set)", async () => {
      const state = t.init({ creator: "alice" });
      await expect(t.send(state, "stranger", { type: "ADD_TODO", text: "Nope" })).rejects.toThrow(/not found/i);
    });

    it("member cannot delete (not in their role)", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "INVITE", userId: "bob" });
      state = await t.send(state, "alice", { type: "ADD_TODO", text: "Test" });
      await expect(t.send(state, "bob", { type: "DELETE_TODO", id: "todo-1" })).rejects.toThrow(/not found/i);
    });

    it("rejects invalid payload", async () => {
      const state = t.init({ creator: "alice" });
      await expect(t.send(state, "alice", { type: "ADD_TODO", text: "" })).rejects.toThrow(/validation/i);
    });

    it("toggle works", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "ADD_TODO", text: "Test" });
      expect(state.todos[0]?.done).toBe(false);
      state = await t.send(state, "alice", { type: "TOGGLE", id: "todo-1" });
      expect(state.todos[0]?.done).toBe(true);
    });
  });

  describe("view", () => {
    it("owner view includes todos and memberCount", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "ADD_TODO", text: "Test" });
      state = await t.send(state, "alice", { type: "INVITE", userId: "bob" });

      const ownerView = t.view(state, "alice");
      expect(ownerView.role).toBe("owner");
      expect(ownerView.data).toEqual({
        todos: [{ id: "todo-1", text: "Test", done: false }],
        memberCount: 1,
      });
    });

    it("viewer view includes counts, not todos", async () => {
      let state = t.init({ creator: "alice" });
      state = await t.send(state, "alice", { type: "ADD_TODO", text: "A" });
      state = await t.send(state, "alice", { type: "ADD_TODO", text: "B" });
      state = await t.send(state, "alice", { type: "TOGGLE", id: "todo-1" });

      const viewerView = t.view(state, "stranger");
      expect(viewerView.role).toBe("viewer");
      expect(viewerView.data).toEqual({ todoCount: 2, doneCount: 1 });
    });

    it("throws when caller has no role", () => {
      const strictDef = {
        ...todoActorDef,
        roles: {
          owner: (state: State, caller: string) => caller === state.ownerId,
        },
        messages: { owner: todoActorDef.messages.owner },
        views: { owner: todoActorDef.views.owner },
      };
      const strict = testActor(strictDef);
      const state = strict.init({ creator: "alice" });
      expect(() => strict.view(state, "stranger")).toThrow(/no role/i);
    });
  });

  describe("sendWithEffects", () => {
    it("captures executions from execute()", async () => {
      const notifyMsg = message(z.object({}), (state: State, _payload, ctx) => {
        ctx.execute("EMAIL", { to: state.memberIds });
        return state;
      });

      const defWithNotify = {
        ...todoActorDef,
        messages: {
          ...todoActorDef.messages,
          owner: { ...todoActorDef.messages.owner, NOTIFY: notifyMsg },
        },
      };

      const tw = testActor(defWithNotify);
      const state = tw.init({ creator: "alice" });
      const { state: nextState, executions } = await tw.sendWithEffects(state, "alice", { type: "NOTIFY" });

      expect(nextState).toEqual(state);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toEqual({ service: "EMAIL", payload: { to: [] } });
    });
  });
});
