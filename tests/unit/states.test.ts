import { describe, it, expect } from "vitest";
import { z } from "zod";
import { message } from "../../packages/actor-kit/src/core/message";
import {
  resolveMessagesForState,
  type StateConfig,
  type SequentialStates,
  type ParallelStates,
} from "../../packages/actor-kit/src/runtime/states";

type State = { status: string; count: number; items: string[] };

const increment = message(
  z.object({ amount: z.number() }),
  (state: State, { amount }) => ({ ...state, count: state.count + amount }),
);

const addItem = message(
  z.object({ text: z.string() }),
  (state: State, { text }) => ({ ...state, items: [...state.items, text] }),
);

const archive = message(
  z.object({}),
  (state: State) => ({ ...state, status: "archived" }),
);

const unarchive = message(
  z.object({}),
  (state: State) => ({ ...state, status: "active" }),
);

const lock = message(
  z.object({}),
  (state: State) => ({ ...state, locked: true }),
);

const unlock = message(
  z.object({}),
  (state: State) => ({ ...state, locked: false }),
);

describe("states", () => {
  describe("no states (flat messages)", () => {
    it("returns all messages when no state config", () => {
      const flatMessages = {
        admin: { INCREMENT: increment, ADD_ITEM: addItem },
        viewer: {},
      };

      const result = resolveMessagesForState(flatMessages, undefined, undefined);
      expect(result).toBe(flatMessages);
    });
  });

  describe("sequential states", () => {
    const statesConfig: SequentialStates<State> = {
      active: {
        messages: {
          admin: { INCREMENT: increment, ADD_ITEM: addItem, ARCHIVE: archive },
          viewer: {},
        },
      },
      archived: {
        messages: {
          admin: { UNARCHIVE: unarchive },
          viewer: {},
        },
      },
    };

    it("returns messages for the current state", () => {
      const result = resolveMessagesForState(undefined, statesConfig, { current: "active" });
      expect(result).toBeDefined();
      expect(result?.["admin"]).toHaveProperty("INCREMENT");
      expect(result?.["admin"]).toHaveProperty("ARCHIVE");
      expect(result?.["admin"]).not.toHaveProperty("UNARCHIVE");
    });

    it("returns archived messages when in archived state", () => {
      const result = resolveMessagesForState(undefined, statesConfig, { current: "archived" });
      expect(result?.["admin"]).toHaveProperty("UNARCHIVE");
      expect(result?.["admin"]).not.toHaveProperty("INCREMENT");
    });

    it("returns undefined for unknown state", () => {
      const result = resolveMessagesForState(undefined, statesConfig, { current: "nonexistent" });
      expect(result).toBeUndefined();
    });
  });

  describe("parallel states", () => {
    const parallelConfig: ParallelStates<State> = {
      parallel: true,
      regions: {
        lifecycle: {
          initial: "active",
          states: {
            active: {
              messages: {
                admin: { INCREMENT: increment, ARCHIVE: archive },
              },
            },
            archived: {
              messages: {
                admin: { UNARCHIVE: unarchive },
              },
            },
          },
        },
        editing: {
          initial: "unlocked",
          states: {
            unlocked: {
              messages: {
                admin: { ADD_ITEM: addItem, LOCK: lock },
              },
            },
            locked: {
              messages: {
                admin: { UNLOCK: unlock },
              },
            },
          },
        },
      },
    };

    it("merges messages from all active regions", () => {
      const regionStates = { lifecycle: "active", editing: "unlocked" };
      const result = resolveMessagesForState(undefined, parallelConfig, regionStates);

      expect(result?.["admin"]).toHaveProperty("INCREMENT");
      expect(result?.["admin"]).toHaveProperty("ARCHIVE");
      expect(result?.["admin"]).toHaveProperty("ADD_ITEM");
      expect(result?.["admin"]).toHaveProperty("LOCK");
      expect(result?.["admin"]).not.toHaveProperty("UNARCHIVE");
      expect(result?.["admin"]).not.toHaveProperty("UNLOCK");
    });

    it("uses different messages when regions change", () => {
      const regionStates = { lifecycle: "archived", editing: "locked" };
      const result = resolveMessagesForState(undefined, parallelConfig, regionStates);

      expect(result?.["admin"]).toHaveProperty("UNARCHIVE");
      expect(result?.["admin"]).toHaveProperty("UNLOCK");
      expect(result?.["admin"]).not.toHaveProperty("INCREMENT");
      expect(result?.["admin"]).not.toHaveProperty("ADD_ITEM");
    });

    it("handles mixed region states", () => {
      const regionStates = { lifecycle: "active", editing: "locked" };
      const result = resolveMessagesForState(undefined, parallelConfig, regionStates);

      expect(result?.["admin"]).toHaveProperty("INCREMENT");
      expect(result?.["admin"]).toHaveProperty("ARCHIVE");
      expect(result?.["admin"]).toHaveProperty("UNLOCK");
      expect(result?.["admin"]).not.toHaveProperty("ADD_ITEM");
      expect(result?.["admin"]).not.toHaveProperty("LOCK");
    });
  });
});
