import { schema, string, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// --- Test actor with services ---

const CounterView = schema({ count: uint32, status: string });

const CounterContract = defineActor("counter", {
  input: z.object({}),
  init: () => ({ count: 0, status: "idle", error: "" }),

  roles: { user: () => true },

  services: {
    fetchCount: {
      fn: async () => ({ count: 42 }),
      onDone: (state, result) => ({
        ...state,
        count: result.count,
        status: "loaded",
      }),
      onError: (state, error) => ({
        ...state,
        error: error.message,
        status: "failed",
      }),
    },
  },

  messages: {
    INCREMENT: message(z.object({}), (state) => ({
      ...state,
      count: state.count + 1,
    })),

    FETCH: message(z.object({}), (state, _, { execute }) => {
      execute("fetchCount", {});
      return { ...state, status: "loading" };
    }),
  },

  views: {
    user: view.shared(CounterView, (state) => ({
      count: state.count,
      status: state.status,
    })),
  },
});

// --- Timeline tests ---

describe("timeline", () => {
  describe("message mutations", () => {
    it("records a timeline entry for each message", async () => {
      const t = testActor(CounterContract);
      let state = t.init({});

      const result = await t.send(state, "alice", { type: "INCREMENT" });
      state = result.state;

      expect(result.timeline).toHaveLength(1);

      const [entry] = result.timeline;
      expect(entry).toBeDefined();
      expect(entry?.cause.type).toBe("message");
      if (entry?.cause.type === "message") {
        expect(entry.cause.messageType).toBe("INCREMENT");
        expect(entry.cause.caller).toBe("alice");
        expect(entry.cause.callerType).toBe("user");
        expect(entry.cause.role).toBe("user");
      }
      expect(entry?.stateSnapshot).toEqual({
        count: 1,
        status: "idle",
        error: "",
      });
      expect(entry?.createdAt).toBeTypeOf("number");
    });

    it("records payload in the timeline entry", async () => {
      const PayloadContract = defineActor("payload-test", {
        input: z.object({}),
        init: () => ({ value: "" }),
        roles: { user: () => true },
        messages: {
          SET: message(z.object({ value: z.string() }), (state, { value }) => ({
            ...state,
            value,
          })),
        },
        views: {
          user: view.shared(schema({ value: string }), (state) => ({
            value: state.value,
          })),
        },
      });

      const t = testActor(PayloadContract);
      const state = t.init({});
      const result = await t.send(state, "alice", {
        type: "SET",
        value: "hello",
      });

      const [entry] = result.timeline;
      expect(entry).toBeDefined();
      if (entry?.cause.type === "message") {
        expect(entry.cause.payload).toEqual({ value: "hello" });
      }
    });

    it("does not record a timeline entry when message is rejected", async () => {
      const GuardedContract = defineActor("guarded", {
        input: z.object({}),
        init: () => ({ count: 0 }),
        roles: {
          admin: (_s, caller: string) => caller === "admin",
        },
        messages: {
          INC: message(z.object({}), (state) => ({ count: state.count + 1 })),
        },
        views: {
          admin: view.shared(schema({ count: uint32 }), (state) => ({
            count: state.count,
          })),
        },
      });

      const t = testActor(GuardedContract);
      const state = t.init({});

      // "bob" has no role — should throw
      await expect(t.send(state, "bob", { type: "INC" })).rejects.toThrow();
    });
  });

  describe("service mutations", () => {
    it("records executions in send result for service invocations", async () => {
      const t = testActor(CounterContract);
      const state = t.init({});

      const result = await t.send(state, "alice", { type: "FETCH" });

      // The message itself should have a timeline entry
      expect(result.timeline).toHaveLength(1);

      const [entry] = result.timeline;
      expect(entry?.cause.type).toBe("message");

      // Service execution is captured in executions (not timeline — services execute async in real DO)
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0]?.service).toBe("fetchCount");
    });
  });
});
