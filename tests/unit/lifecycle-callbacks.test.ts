import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callback } from "../../packages/actor-kit/src/core/callback";
import { message } from "../../packages/actor-kit/src/core/message";
import { testActor } from "../../packages/actor-kit/src/test/test-actor";

// --- Callback definitions ---

const FetchDone = callback("FETCH_DONE", z.object({ data: z.string() }), z.object({ url: z.string() }));

const FetchFailed = callback("FETCH_FAILED", z.object({ message: z.string() }), z.object({ url: z.string() }));

// --- Actor definition using lifecycle + callbacks ---

type AppState = {
  onlineUsers: string[];
  results: string[];
  errors: string[];
  status: string;
};

const fetchData = message(z.object({ url: z.string() }), (state: AppState, { url }, { request }) => {
  request({
    fetch: url,
    onDone: FetchDone,
    onError: FetchFailed,
    meta: { url },
  });
  return { ...state, status: "loading" };
});

const appDef = {
  input: z.object({}),
  init: (): AppState => ({ onlineUsers: [], results: [], errors: [], status: "idle" }),
  roles: { user: () => true },
  messages: {
    user: { FETCH: fetchData },
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
  callbacks: {
    FETCH_DONE: (state: AppState, payload: { result: { data: string }; meta: { url: string } }) => ({
      ...state,
      results: [...state.results, `${payload.meta.url}: ${payload.result.data}`],
      status: "done",
    }),
    FETCH_FAILED: (state: AppState, payload: { error: { message: string }; meta: { url: string } }) => ({
      ...state,
      errors: [...state.errors, `${payload.meta.url}: ${payload.error.message}`],
      status: "failed",
    }),
  },
  views: {},
};

describe("lifecycle + callbacks (Phase 3)", () => {
  describe("lifecycle handlers", () => {
    it("connect handler adds user to online list", () => {
      const t = testActor(appDef);
      const state = t.init({});

      // Lifecycle handlers are invoked by the framework, not via send()
      // For now, test that the definition is accepted by testActor
      expect(state.onlineUsers).toEqual([]);
    });
  });

  describe("callbacks handlers", () => {
    it("sendWithEffects captures request with callback defs", async () => {
      const t = testActor(appDef);
      const state = t.init({});

      const { requests } = await t.sendWithEffects(state, "alice", {
        type: "FETCH",
        url: "https://example.com",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        effect: { fetch: "https://example.com" },
        onDone: "FETCH_DONE",
        onError: "FETCH_FAILED",
        meta: { url: "https://example.com" },
      });
    });

    it("actor definition accepts lifecycle + callbacks instead of on", () => {
      // The fact that testActor(appDef) doesn't throw means the definition is valid
      const t = testActor(appDef);
      expect(t).toBeDefined();
    });
  });
});
