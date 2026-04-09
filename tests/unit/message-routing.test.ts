import { message, routeMessage } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { count: number; items: string[] };

const increment = message(z.object({ amount: z.number().positive() }), (state: State, { amount }) => ({
  ...state,
  count: state.count + amount,
}));

const addItem = message(z.object({ text: z.string().min(1) }), {
  guard: (state: State) => state.items.length < 3,
  handler: (state: State, { text }) => ({
    ...state,
    items: [...state.items, text],
  }),
});

const reset = message(z.object({}), (_state: State) => ({ count: 0, items: [] }));

const roleMessages = {
  admin: { INCREMENT: increment, ADD_ITEM: addItem, RESET: reset },
  viewer: {},
};

describe("routeMessage()", () => {
  const baseCtx = {
    caller: "alice",
    callerType: "user" as const,
    env: {},
    execute: () => {},
  };

  it("routes a valid message to the correct handler", async () => {
    const result = await routeMessage(
      roleMessages,
      "admin",
      { count: 0, items: [] },
      { type: "INCREMENT", amount: 5 },
      baseCtx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toEqual({ count: 5, items: [] });
    }
  });

  it("rejects message type not in role", async () => {
    const result = await routeMessage(
      roleMessages,
      "viewer",
      { count: 0, items: [] },
      { type: "INCREMENT", amount: 5 },
      baseCtx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("message_not_found");
    }
  });

  it("rejects invalid payload (Zod validation)", async () => {
    const result = await routeMessage(
      roleMessages,
      "admin",
      { count: 0, items: [] },
      { type: "INCREMENT", amount: -1 },
      baseCtx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("validation_failed");
    }
  });

  it("rejects when guard returns false", async () => {
    const fullState: State = { count: 0, items: ["a", "b", "c"] };
    const result = await routeMessage(roleMessages, "admin", fullState, { type: "ADD_ITEM", text: "d" }, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("guard_failed");
    }
  });

  it("passes guard and runs handler when guard returns true", async () => {
    const result = await routeMessage(
      roleMessages,
      "admin",
      { count: 0, items: [] },
      { type: "ADD_ITEM", text: "hello" },
      baseCtx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toEqual({ count: 0, items: ["hello"] });
    }
  });

  it("rejects missing payload fields", async () => {
    const result = await routeMessage(
      roleMessages,
      "admin",
      { count: 0, items: [] },
      { type: "INCREMENT" }, // missing 'amount'
      baseCtx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("validation_failed");
    }
  });

  it("passes correct ctx to handler", async () => {
    let receivedRole: string | undefined;
    const trackingMsg = message(z.object({}), (state: State, _payload, ctx) => {
      receivedRole = ctx.role;
      return state;
    });

    const testRoleMessages = { admin: { TRACK: trackingMsg } };
    await routeMessage(testRoleMessages, "admin", { count: 0, items: [] }, { type: "TRACK" }, baseCtx);

    expect(receivedRole).toBe("admin");
  });

  it("collects execute calls during handler execution", async () => {
    const executions: unknown[] = [];
    const executeCtx = {
      ...baseCtx,
      execute: (service: unknown, payload: unknown) => {
        executions.push({ service, payload });
      },
    };

    const notifyMsg = message(z.object({}), (state: State, _payload, ctx) => {
      ctx.execute("TEST_QUEUE", { hello: true });
      return state;
    });

    const testRoleMessages = { admin: { NOTIFY: notifyMsg } };
    await routeMessage(testRoleMessages, "admin", { count: 0, items: [] }, { type: "NOTIFY" }, executeCtx);

    expect(executions).toHaveLength(1);
    expect(executions[0]).toEqual({ service: "TEST_QUEUE", payload: { hello: true } });
  });

  it("handles no-payload messages", async () => {
    const result = await routeMessage(roleMessages, "admin", { count: 5, items: ["a"] }, { type: "RESET" }, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toEqual({ count: 0, items: [] });
    }
  });
});
