import { describe, it, expect } from "vitest";
import { schema, uint32, string, boolean, array } from "../../packages/actor-kit/src/schema/schema";
import { view } from "../../packages/actor-kit/src/core/view";

describe("view() helper", () => {
  const TodoItem = schema({ id: string, text: string, done: boolean });
  const OwnerView = schema({ todos: array(TodoItem), memberCount: uint32 });

  type State = {
    todos: { id: string; text: string; done: boolean }[];
    memberIds: string[];
  };

  it("pairs a schema with a projection function", () => {
    const ownerView = view(OwnerView, (state: State) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    }));

    expect(ownerView.schema).toBe(OwnerView);
    expect(typeof ownerView.fn).toBe("function");
  });

  it("projection function receives state and caller", () => {
    const ownerView = view(OwnerView, (state: State, _caller) => ({
      todos: state.todos,
      memberCount: state.memberIds.length,
    }));

    const state: State = {
      todos: [{ id: "1", text: "test", done: false }],
      memberIds: ["alice", "bob"],
    };

    const result = ownerView.fn(state, "alice");
    expect(result.todos).toHaveLength(1);
    expect(result.memberCount).toBe(2);
  });

  it("return type must match schema shape", () => {
    const CountView = schema({ todoCount: uint32, doneCount: uint32 });

    const viewerView = view(CountView, (state: State) => ({
      todoCount: state.todos.length,
      doneCount: state.todos.filter((t) => t.done).length,
    }));

    const state: State = {
      todos: [
        { id: "1", text: "a", done: true },
        { id: "2", text: "b", done: false },
      ],
      memberIds: [],
    };

    const result = viewerView.fn(state, "someone");
    expect(result.todoCount).toBe(2);
    expect(result.doneCount).toBe(1);
  });

  it("carries schema reference for later encoding", () => {
    const SimpleView = schema({ count: uint32 });
    const v = view(SimpleView, (state: { count: number }) => ({
      count: state.count,
    }));

    expect(v.schema.fields).toHaveLength(1);
    expect(v.schema.fields[0]?.name).toBe("count");
  });
});
