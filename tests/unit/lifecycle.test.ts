import { testActor } from "@actor-kit/test";
import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Actor definition using lifecycle (no callbacks, no request) ---

type AppState = {
  onlineUsers: string[];
  count: number;
};

const increment = message(z.object({ amount: z.number() }), (state: AppState, { amount }, ctx) => {
  // emit() is the only side-effect mechanism — no request()
  ctx.emit({ queue: "ANALYTICS", body: { count: state.count + amount } });
  return { ...state, count: state.count + amount };
});

const appDef = {
  input: z.object({}),
  init: (): AppState => ({ onlineUsers: [], count: 0 }),
  roles: { user: () => true },
  messages: {
    user: { INCREMENT: increment },
  },
  lifecycle: {
    connect: (state: AppState, event: { caller: string; callerType: "user" | "service" }) => ({
      ...state,
      onlineUsers: [...state.onlineUsers, event.caller],
    }),
    disconnect: (state: AppState, event: { caller: string; callerType: "user" | "service" }) => ({
      ...state,
      onlineUsers: state.onlineUsers.filter((u) => u !== event.caller),
    }),
  },
  views: {},
};

describe("lifecycle handlers (v3 — no callbacks)", () => {
  it("actor definition with lifecycle is accepted by testActor", () => {
    const t = testActor(appDef);
    expect(t).toBeDefined();
  });

  it("init returns correct initial state", () => {
    const t = testActor(appDef);
    const state = t.init({});
    expect(state.onlineUsers).toEqual([]);
    expect(state.count).toBe(0);
  });

  it("sendWithEffects returns emissions only (no requests)", async () => {
    const t = testActor(appDef);
    const state = t.init({});

    const result = await t.sendWithEffects(state, "alice", {
      type: "INCREMENT",
      amount: 5,
    });

    expect(result.state.count).toBe(5);
    expect(result.emissions).toHaveLength(1);
    expect(result.emissions[0]).toEqual({ queue: "ANALYTICS", body: { count: 5 } });
    // v3: sendWithEffects no longer returns 'requests' — only emissions
    expect(result).not.toHaveProperty("requests");
  });
});
