import { describe, it, expect } from "vitest";
import { z } from "zod";
import { message } from "../../packages/actor-kit/src/core/message";
import { testActor } from "../../packages/actor-kit/src/test/test-actor";
import { schema, uint32, string } from "../../packages/actor-kit/src/schema/schema";
import { view } from "../../packages/actor-kit/src/core/view";

type State = { count: number; status: string; fetchResult: string | null };

const CountView = schema({ count: uint32, status: string });

const fetchData = message(
  z.object({ url: z.string() }),
  (state: State, { url }, ctx) => {
    ctx.request({
      fetch: url,
      onDone: "FETCH_DONE",
      onError: "FETCH_FAILED",
    });
    return { ...state, status: "loading" };
  },
);

const increment = message(
  z.object({ amount: z.number() }),
  (state: State, { amount }) => ({ ...state, count: state.count + amount }),
);

describe("request() callback capture", () => {
  const def = {
    input: z.object({}),
    init: (): State => ({ count: 0, status: "idle", fetchResult: null }),
    roles: { user: () => true },
    messages: { user: { FETCH: fetchData, INCREMENT: increment } },
    views: {
      user: view(CountView, (state: State) => ({ count: state.count, status: state.status })),
    },
  };

  it("captures request() calls with onDone/onError names", async () => {
    const t = testActor(def);
    const state = t.init({});
    const { state: nextState, requests, emissions } = await t.sendWithEffects(
      state, "alice", { type: "FETCH", url: "https://example.com" },
    );

    expect(nextState.status).toBe("loading");
    expect(emissions).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      fetch: "https://example.com",
      onDone: "FETCH_DONE",
      onError: "FETCH_FAILED",
    });
  });

  it("transitions state correctly before the request", async () => {
    const t = testActor(def);
    let state = t.init({});
    state = await t.send(state, "alice", { type: "FETCH", url: "https://example.com" });

    expect(state.status).toBe("loading");
    expect(state.count).toBe(0);
  });

  it("can send other messages while request is pending", async () => {
    const t = testActor(def);
    let state = t.init({});
    state = await t.send(state, "alice", { type: "FETCH", url: "https://example.com" });
    state = await t.send(state, "alice", { type: "INCREMENT", amount: 5 });

    expect(state.status).toBe("loading");
    expect(state.count).toBe(5);
  });
});
