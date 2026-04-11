import { schema, string, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type CounterState = { count: number };

const CounterView = schema({ count: uint32, label: string });

const forwardOne = message(
  z.object({ targetId: z.string() }),
  (
    state: CounterState,
    { targetId }: { targetId: string },
    ctx: {
      forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) => void;
    },
  ) => {
    ctx.forward("COUNTER", targetId, { type: "INCREMENT", amount: 5 });
    return state;
  },
);

const forwardMany = message(
  z.object({ targets: z.array(z.string()) }),
  (
    state: CounterState,
    { targets }: { targets: string[] },
    ctx: {
      forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) => void;
    },
  ) => {
    for (const t of targets) {
      ctx.forward("COUNTER", t, { type: "INCREMENT", amount: 1 });
    }
    return state;
  },
);

const forwardDifferentLinks = message(
  z.object({}),
  (
    state: CounterState,
    _p: Record<string, never>,
    ctx: {
      forward: (linkName: string, targetId: string, message: { type: string; [key: string]: unknown }) => void;
    },
  ) => {
    ctx.forward("PROFILE", "p1", { type: "PING" });
    ctx.forward("ROOM", "r1", { type: "PING" });
    return state;
  },
);

const ForwardContract = defineActor("forwarder", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0 }),
  roles: {
    user: () => true,
  },
  messages: {
    FORWARD_ONE: forwardOne,
    FORWARD_MANY: forwardMany,
    FORWARD_LINKS: forwardDifferentLinks,
  },
  views: {
    user: view.shared(CounterView, (s: CounterState) => ({ count: s.count, label: "" })),
  },
});

describe("forward() in message handlers", () => {
  it("captures a single forward call in sendWithEffects.forwards", async () => {
    const actor = testActor(ForwardContract);
    const state = actor.init({});
    const result = await actor.sendWithEffects(state, "u1", { type: "FORWARD_ONE", targetId: "t1" });
    expect(result.forwards).toHaveLength(1);
    expect(result.forwards[0]).toEqual({
      linkName: "COUNTER",
      targetId: "t1",
      message: { type: "INCREMENT", amount: 5 },
    });
  });

  it("captures multiple forward calls from a single handler", async () => {
    const actor = testActor(ForwardContract);
    const state = actor.init({});
    const result = await actor.sendWithEffects(state, "u1", {
      type: "FORWARD_MANY",
      targets: ["a", "b", "c"],
    });
    expect(result.forwards).toHaveLength(3);
    expect(result.forwards.map((f) => f.targetId)).toEqual(["a", "b", "c"]);
  });

  it("preserves the full message shape", async () => {
    const actor = testActor(ForwardContract);
    const state = actor.init({});
    const result = await actor.sendWithEffects(state, "u1", { type: "FORWARD_ONE", targetId: "x" });
    expect(result.forwards[0]?.message).toEqual({ type: "INCREMENT", amount: 5 });
  });

  it("captures different link names", async () => {
    const actor = testActor(ForwardContract);
    const state = actor.init({});
    const result = await actor.sendWithEffects(state, "u1", { type: "FORWARD_LINKS" });
    expect(result.forwards).toHaveLength(2);
    expect(result.forwards.map((f) => f.linkName)).toEqual(["PROFILE", "ROOM"]);
  });
});
