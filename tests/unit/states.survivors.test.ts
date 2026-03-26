import {
  message,
  type ParallelStates,
  resolveMessagesForState,
  type SequentialStates,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { status: string };

const handler = message(z.object({}), (state: State) => state);

describe("states — kill survivors", () => {
  describe("sequential states", () => {
    const states: SequentialStates<State> = {
      active: { messages: { admin: { DO_THING: handler } } },
      archived: { messages: { admin: { UNARCHIVE: handler } } },
    };

    it("returns correct messages for active state", () => {
      const result = resolveMessagesForState(undefined, states, { current: "active" });
      expect(result?.admin).toHaveProperty("DO_THING");
      expect(result?.admin).not.toHaveProperty("UNARCHIVE");
    });

    it("returns correct messages for archived state", () => {
      const result = resolveMessagesForState(undefined, states, { current: "archived" });
      expect(result?.admin).toHaveProperty("UNARCHIVE");
      expect(result?.admin).not.toHaveProperty("DO_THING");
    });

    it("returns undefined for unknown state name", () => {
      const result = resolveMessagesForState(undefined, states, { current: "deleted" });
      expect(result).toBeUndefined();
    });

    it("returns undefined when stateTracker is undefined", () => {
      const result = resolveMessagesForState(undefined, states, undefined);
      expect(result).toBeUndefined();
    });
  });

  describe("parallel states", () => {
    const parallel: ParallelStates<State> = {
      parallel: true,
      regions: {
        lifecycle: {
          initial: "active",
          states: {
            active: { messages: { user: { EDIT: handler } } },
            archived: { messages: { user: {} } },
          },
        },
        lock: {
          initial: "unlocked",
          states: {
            unlocked: { messages: { user: { LOCK: handler } } },
            locked: { messages: { user: { UNLOCK: handler } } },
          },
        },
      },
    };

    it("merges messages from two active regions", () => {
      const result = resolveMessagesForState(undefined, parallel, {
        lifecycle: "active",
        lock: "unlocked",
      });
      expect(result?.user).toHaveProperty("EDIT");
      expect(result?.user).toHaveProperty("LOCK");
    });

    it("returns only lock messages when lifecycle is archived", () => {
      const result = resolveMessagesForState(undefined, parallel, {
        lifecycle: "archived",
        lock: "locked",
      });
      expect(result?.user).toHaveProperty("UNLOCK");
      expect(result?.user).not.toHaveProperty("EDIT");
    });

    it("returns undefined if parallel tracker is sequential", () => {
      const result = resolveMessagesForState(undefined, parallel, { current: "active" });
      expect(result).toBeUndefined();
    });

    it("ignores unknown region states gracefully", () => {
      const result = resolveMessagesForState(undefined, parallel, {
        lifecycle: "active",
        lock: "nonexistent",
      });
      // Should still have lifecycle messages
      expect(result?.user).toHaveProperty("EDIT");
    });
  });

  describe("flat messages (no states)", () => {
    it("returns flat messages when statesConfig is undefined", () => {
      const flat = { admin: { DO_THING: handler } };
      const result = resolveMessagesForState(flat, undefined, undefined);
      expect(result).toBe(flat);
    });
  });
});
