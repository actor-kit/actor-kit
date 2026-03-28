import { schema, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { count: number; ownerId: string };
const CountView = schema({ count: uint32 });

const increment = message(z.object({ amount: z.number() }), (state: State, { amount }) => ({
  ...state,
  count: state.count + amount,
}));

describe("testActor — kill survivors", () => {
  const def = {
    input: z.object({ ownerId: z.string() }),
    init: (input: { ownerId: string }): State => ({ count: 0, ownerId: input.ownerId }),
    roles: {
      owner: (state: State, caller: string) => caller === state.ownerId,
    },
    messages: { owner: { INCREMENT: increment } },
    views: {
      owner: view(CountView, (state: State) => ({ count: state.count })),
    },
  };

  it("init validates input with Zod", () => {
    const t = testActor(def);
    expect(() => t.init({} as { ownerId: string })).toThrow(/invalid/i);
  });

  it("init returns correct state shape", () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    expect(state.count).toBe(0);
    expect(state.ownerId).toBe("alice");
  });

  it("role returns null for unmatched caller", () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    expect(t.role(state, "bob")).toBeNull();
  });

  it("role returns correct role name", () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    expect(t.role(state, "alice")).toBe("owner");
  });

  it("send throws when caller has no role", async () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    await expect(t.send(state, "bob", { type: "INCREMENT", amount: 1 })).rejects.toThrow(/no role/i);
  });

  it("send throws for unknown message type", async () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    await expect(t.send(state, "alice", { type: "UNKNOWN" })).rejects.toThrow(/not found/i);
  });

  it("send with callerType service changes role resolution", async () => {
    const defWithService = {
      ...def,
      roles: {
        service: (_s: State, _c: string, claims: { callerType: "user" | "service" }) => claims.callerType === "service",
        owner: (state: State, caller: string) => caller === state.ownerId,
      },
      messages: {
        service: { INCREMENT: increment },
        owner: { INCREMENT: increment },
      },
      views: {
        service: view(CountView, (state: State) => ({ count: state.count })),
        owner: view(CountView, (state: State) => ({ count: state.count })),
      },
    };
    const t = testActor(defWithService);
    const state = t.init({ ownerId: "alice" });
    expect(t.role(state, "svc", { callerType: "service" })).toBe("service");
  });

  it("view throws for caller with no role", () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    expect(() => t.view(state, "bob")).toThrow(/no role/i);
  });

  it("view returns role discriminant", () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    const v = t.view(state, "alice");
    expect(v.role).toBe("owner");
    expect(v.data).toEqual({ count: 0 });
  });

  it("sendWithEffects returns empty emissions for normal handler", async () => {
    const t = testActor(def);
    const state = t.init({ ownerId: "alice" });
    const result = await t.sendWithEffects(state, "alice", { type: "INCREMENT", amount: 5 });
    expect(result.emissions).toHaveLength(0);
    expect(result.state.count).toBe(5);
  });
});
