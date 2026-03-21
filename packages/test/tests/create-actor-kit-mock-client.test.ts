import { describe, expect, it, vi } from "vitest";
import { createActorKitMockClient } from "@actor-kit/test";

type TestEvent = { type: "ADD_TODO"; text: string };
type TestSnapshot = {
  value: "ready";
  public: {
    todos: Array<{ id: string; text: string; completed: boolean }>;
  };
  private: {};
};

function createSnapshot(): TestSnapshot {
  return {
    private: {},
    public: { todos: [] },
    value: "ready",
  };
}

describe("createActorKitMockClient", () => {
  it("notifies subscribers when produce updates state", () => {
    const client = createActorKitMockClient<TestSnapshot, TestEvent>({
      initialSnapshot: createSnapshot(),
    });
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);

    client.produce((draft) => {
      draft.public.todos.push({
        id: "todo-1",
        text: "Write seam tests",
        completed: false,
      });
    });

    expect(client.getState().public.todos).toEqual([
      {
        id: "todo-1",
        text: "Write seam tests",
        completed: false,
      },
    ]);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    client.produce((draft) => {
      draft.public.todos[0]!.completed = true;
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(client.getState().public.todos[0]?.completed).toBe(true);
  });

  it("forwards sent events and notifies listeners", async () => {
    const onSend = vi.fn();
    const client = createActorKitMockClient<TestSnapshot, TestEvent>({
      initialSnapshot: createSnapshot(),
      onSend,
    });
    const listener = vi.fn();
    client.subscribe(listener);

    await expect(client.connect()).resolves.toBeUndefined();
    client.send({ type: "ADD_TODO", text: "Ship it" });
    client.disconnect();

    expect(onSend).toHaveBeenCalledWith({
      type: "ADD_TODO",
      text: "Ship it",
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("waits for state changes and times out when the predicate never matches", async () => {
    vi.useFakeTimers();
    const client = createActorKitMockClient<TestSnapshot, TestEvent>({
      initialSnapshot: createSnapshot(),
    });

    const resolvedWait = client.waitFor(
      (state) => state.public.todos.some((todo) => todo.id === "todo-1"),
      100
    );

    client.produce((draft) => {
      draft.public.todos.push({
        id: "todo-1",
        text: "Kill survivors",
        completed: false,
      });
    });

    await expect(resolvedWait).resolves.toBeUndefined();
    const timedOutWait = expect(
      client.waitFor((state) => state.public.todos.length > 1, 25)
    ).rejects.toThrow("Timeout waiting for condition after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await timedOutWait;
    vi.useRealTimers();
  });
});
