import { schema, string, uint32, view } from "@actor-kit/core";
import { actorContext } from "@actor-kit/react";
import { defineActor, message } from "@actor-kit/worker/testing";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

// --- Test fixtures ---

type CounterState = { count: number; name: string };

const CounterView = schema({ count: uint32, name: string });

const Counter = defineActor("counter", {
  input: z.object({}),
  init: (): CounterState => ({ count: 0, name: "" }),
  messages: {
    INCREMENT: message(z.object({ amount: z.number() }), (state: CounterState, { amount }) => ({
      count: state.count + amount,
      name: state.name,
    })),
    RESET: message(z.object({}), (state: CounterState) => ({
      count: 0,
      name: state.name,
    })),
    RENAME: message(z.object({ newName: z.string() }), (state: CounterState, { newName }) => ({
      count: state.count,
      name: newName,
    })),
  },
  views: {
    user: view(CounterView, (state: CounterState) => ({
      count: state.count,
      name: state.name,
    })),
  },
});

// --- Type inference tests ---

describe("contract-derived React context", () => {
  it("actorContext(contract) infers view type from views", () => {
    const Ctx = actorContext(Counter);

    expectTypeOf(Ctx.useView).returns.toEqualTypeOf<{ count: number; name: string } | undefined>();
  });

  it("actorContext(contract) infers message types from flat messages", () => {
    const Ctx = actorContext(Counter);

    type SendFn = ReturnType<typeof Ctx.useSend>;

    // Should accept valid messages
    type ExpectedMessage =
      | { type: "INCREMENT"; amount: number }
      | { type: "RESET" }
      | { type: "RENAME"; newName: string };

    expectTypeOf<SendFn>().toEqualTypeOf<(message: ExpectedMessage) => void>();
  });

  it("useSelector receives typed view from contract", () => {
    const Ctx = actorContext(Counter);

    type SelectorArg = Parameters<typeof Ctx.useSelector<number>>[0];
    expectTypeOf<SelectorArg>().toEqualTypeOf<(view: { count: number; name: string } | undefined) => number>();
  });

  it("actorContext(contract) returns all hooks", () => {
    const Ctx = actorContext(Counter);

    expectTypeOf(Ctx.Provider).toBeFunction();
    expectTypeOf(Ctx.useView).toBeFunction();
    expectTypeOf(Ctx.useSend).toBeFunction();
    expectTypeOf(Ctx.useRole).toBeFunction();
    expectTypeOf(Ctx.useConnectionState).toBeFunction();
    expectTypeOf(Ctx.useSelector).toBeFunction();
  });

  it("view type is union when contract has multiple views", () => {
    const MultiViewSchema = schema({ total: uint32 });

    const MultiView = defineActor("multi", {
      input: z.object({}),
      init: (): CounterState => ({ count: 0, name: "" }),
      messages: {
        INC: message(z.object({}), (state: CounterState) => state),
      },
      views: {
        admin: view(CounterView, (state: CounterState) => ({
          count: state.count,
          name: state.name,
        })),
        viewer: view(MultiViewSchema, (state: CounterState) => ({
          total: state.count,
        })),
      },
    });

    const Ctx = actorContext(MultiView);

    expectTypeOf(Ctx.useView).returns.toEqualTypeOf<{ count: number; name: string } | { total: number } | undefined>();
  });
});
