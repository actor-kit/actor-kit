import { schema, uint32, view } from "@actor-kit/core";
import { testActor } from "@actor-kit/test";
import { message } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type State = { count: number };
const CountView = schema({ count: uint32 });

const increment = message(z.object({ amount: z.number() }), (state: State, { amount }) => ({
  count: state.count + amount,
}));

describe("observe.onTransition", () => {
  it("fires after each transition with correct args", async () => {
    const transitions: Array<{
      prevState: State;
      nextState: State;
      eventType: string;
      caller: string;
      role: string;
    }> = [];

    const def = {
      input: z.object({}),
      init: (): State => ({ count: 0 }),
      roles: { user: () => true },
      messages: { user: { INCREMENT: increment } },
      views: {
        user: view(CountView, (state: State) => ({ count: state.count })),
      },
      observe: {
        onTransition(
          prevState: State,
          nextState: State,
          event: { type: string },
          ctx: { caller: string; role: string },
        ) {
          transitions.push({
            prevState: { ...prevState },
            nextState: { ...nextState },
            eventType: event.type,
            caller: ctx.caller,
            role: ctx.role,
          });
        },
      },
    };

    const t = testActor(def);
    let state = t.init({});
    state = await t.send(state, "alice", { type: "INCREMENT", amount: 5 });
    state = await t.send(state, "bob", { type: "INCREMENT", amount: 3 });

    expect(transitions).toHaveLength(2);

    expect(transitions[0]?.prevState.count).toBe(0);
    expect(transitions[0]?.nextState.count).toBe(5);
    expect(transitions[0]?.eventType).toBe("INCREMENT");
    expect(transitions[0]?.caller).toBe("alice");
    expect(transitions[0]?.role).toBe("user");

    expect(transitions[1]?.prevState.count).toBe(5);
    expect(transitions[1]?.nextState.count).toBe(8);
    expect(transitions[1]?.caller).toBe("bob");
  });

  it("does not fire when message is rejected", async () => {
    const transitions: unknown[] = [];

    const def = {
      input: z.object({}),
      init: (): State => ({ count: 0 }),
      roles: {
        admin: (_s: State, caller: string) => caller === "admin",
      },
      messages: { admin: { INCREMENT: increment } },
      views: {
        admin: view(CountView, (state: State) => ({ count: state.count })),
      },
      observe: {
        onTransition() {
          transitions.push("fired");
        },
      },
    };

    const t = testActor(def);
    const state = t.init({});

    // "bob" has no role — should throw, not fire onTransition
    await expect(t.send(state, "bob", { type: "INCREMENT", amount: 1 })).rejects.toThrow();

    expect(transitions).toHaveLength(0);
  });
});
