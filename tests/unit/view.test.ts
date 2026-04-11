import { array, boolean, schema, string, uint32, view } from "@actor-kit/core";
import { describe, expect, it } from "vitest";

const TodoItem = schema({ id: string, text: string, done: boolean });
const OwnerView = schema({ todos: array(TodoItem), memberCount: uint32 });

type State = {
  todos: { id: string; text: string; done: boolean }[];
  memberIds: string[];
};

describe("view.shared()", () => {
  it("returns a SharedViewDef with kind 'shared'", () => {
    const v = view.shared(OwnerView, (state: State) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    }));
    expect(v.kind).toBe("shared");
    expect(v.schema).toBe(OwnerView);
    expect(typeof v.fn).toBe("function");
  });

  it("projection receives only state (no caller)", () => {
    const v = view.shared(OwnerView, (state: State) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    }));
    const state: State = {
      todos: [{ id: "1", text: "test", done: false }],
      memberIds: ["alice", "bob"],
    };
    const result = v.fn(state);
    expect(result.todos).toHaveLength(1);
    expect(result.memberCount).toBe(2);
  });

  it("carries schema reference for encoding", () => {
    const SimpleView = schema({ count: uint32 });
    const v = view.shared(SimpleView, (state: { count: number }) => ({
      count: state.count,
    }));
    expect(v.schema.fields).toHaveLength(1);
    expect(v.schema.fields[0]?.name).toBe("count");
  });
});

describe("view.perCaller()", () => {
  it("returns a PerCallerViewDef with kind 'perCaller'", () => {
    const v = view.perCaller(OwnerView, (state: State, _caller) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    }));
    expect(v.kind).toBe("perCaller");
    expect(v.schema).toBe(OwnerView);
    expect(typeof v.fn).toBe("function");
  });

  it("projection receives state and caller", () => {
    const CountView = schema({ todoCount: uint32, doneCount: uint32 });
    const v = view.perCaller(CountView, (state: State, caller) => ({
      todoCount: state.todos.filter((t) => t.id === caller).length || state.todos.length,
      doneCount: state.todos.filter((t) => t.done).length,
    }));
    const state: State = {
      todos: [
        { id: "1", text: "a", done: true },
        { id: "2", text: "b", done: false },
      ],
      memberIds: [],
    };
    const result = v.fn(state, "someone");
    expect(result.todoCount).toBe(2);
    expect(result.doneCount).toBe(1);
  });

  it("carries schema reference for encoding", () => {
    const SimpleView = schema({ count: uint32 });
    const v = view.perCaller(SimpleView, (state: { count: number }, _caller) => ({
      count: state.count,
    }));
    expect(v.schema.fields).toHaveLength(1);
  });
});
