import { schema, string, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Test actor with services ---

const CounterView = schema({ count: uint32, status: string, error: string });

const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: () => ({ count: 0, status: "idle", error: "", lastFetched: null as number | null }),

  roles: { user: () => true },

  services: {
    fetchCount: {
      fn: async (input: { source: string }, _env) => {
        const res = await fetch(`https://api.example.com/count?source=${input.source}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return { count: 42 };
      },
      onDone: (state, result, _input) => ({
        ...state,
        count: result.count,
        status: "loaded",
        error: "",
      }),
      onError: (state, error, input) => ({
        ...state,
        error: `Failed for ${input.source}: ${error.message}`,
        status: "failed",
      }),
    },

    trackEvent: {
      fn: async (input: { event: string }, _env) => {
        await fetch("https://analytics.example.com/track", {
          method: "POST",
          body: JSON.stringify(input),
        });
      },
    },

    saveState: {
      fn: async (input: { count: number }, _env) => {
        await fetch("https://api.example.com/save", {
          method: "POST",
          body: JSON.stringify(input),
        });
      },
      onError: (state, error) => ({
        ...state,
        error: `Save failed: ${error.message}`,
      }),
    },
  },

  messages: {
    INCREMENT: message(z.object({}), (state) => ({
      ...state,
      count: state.count + 1,
    })),

    FETCH_COUNT: message(z.object({ source: z.string() }), (state, { source }, { execute }) => {
      execute("fetchCount", { source });
      return { ...state, status: "loading" };
    }),

    TRACK: message(z.object({ event: z.string() }), (state, { event }, { execute }) => {
      execute("trackEvent", { event });
      return state;
    }),

    SAVE: message(z.object({}), (state, _, { execute }) => {
      execute("saveState", { count: state.count });
      return { ...state, status: "saving" };
    }),
  },

  views: {
    user: view.shared(CounterView, (state) => ({
      count: state.count,
      status: state.status,
      error: state.error,
    })),
  },
});

describe("services + execute()", () => {
  describe("execute captures service invocations", () => {
    it("captures execute() calls in send", async () => {
      const t = testActor(CounterContract);
      const state = t.init({});

      const { state: next, executions } = await t.send(state, "alice", {
        type: "FETCH_COUNT",
        source: "test",
      });

      expect(next.status).toBe("loading");
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        service: "fetchCount",
        input: { source: "test" },
      });
    });

    it("captures fire-and-forget execute (no onDone/onError)", async () => {
      const t = testActor(CounterContract);
      const state = t.init({});

      const { executions } = await t.send(state, "alice", {
        type: "TRACK",
        event: "page_view",
      });

      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        service: "trackEvent",
        input: { event: "page_view" },
      });
    });

    it("captures execute with only onError", async () => {
      const t = testActor(CounterContract);
      let state = t.init({});
      ({ state } = await t.send(state, "alice", { type: "INCREMENT" }));

      const { executions } = await t.send(state, "alice", { type: "SAVE" });

      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        service: "saveState",
        input: { count: 1 },
      });
    });
  });

  describe("sync handlers still work", () => {
    it("sync message works without execute", async () => {
      const t = testActor(CounterContract);
      const state = t.init({});
      const { state: next } = await t.send(state, "alice", { type: "INCREMENT" });

      expect(next.count).toBe(1);
    });
  });

  describe("handler returns state before service runs", () => {
    it("execute does not block the handler", async () => {
      const t = testActor(CounterContract);
      const state = t.init({});
      const { state: next } = await t.send(state, "alice", { type: "FETCH_COUNT", source: "test" });

      // Handler returns immediately with loading state
      expect(next.status).toBe("loading");
      // Count unchanged — service hasn't run yet
      expect(next.count).toBe(0);
    });
  });
});
