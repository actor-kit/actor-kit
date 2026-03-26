import { describe, expect, expectTypeOf, it } from "vitest";
import { actorClient } from "../../packages/actor-kit/src/client/builder";
import { actorContext } from "../../packages/actor-kit/src/react/actor-context";
import { schema, string, uint32 } from "../../packages/actor-kit/src/schema/schema";

const CounterView = schema({ count: uint32, lastUpdatedBy: string });

type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" } | { type: "RESET" };

const CounterClient = actorClient(CounterView).events<CounterEvent>();

describe("actorContext()", () => {
  it("creates a typed React context from factory type", () => {
    const CounterCtx = actorContext<typeof CounterClient>();

    expect(CounterCtx.Provider).toBeDefined();
    expect(CounterCtx.useView).toBeDefined();
    expect(CounterCtx.useSend).toBeDefined();
    expect(CounterCtx.useRole).toBeDefined();
    expect(CounterCtx.useConnectionState).toBeDefined();
    expect(CounterCtx.useSelector).toBeDefined();
  });

  it("useView returns typed view inferred from factory", () => {
    const CounterCtx = actorContext<typeof CounterClient>();

    expectTypeOf(CounterCtx.useView).returns.toEqualTypeOf<{ count: number; lastUpdatedBy: string } | undefined>();
  });

  it("useSend returns typed send inferred from factory", () => {
    const CounterCtx = actorContext<typeof CounterClient>();

    type SendFn = ReturnType<typeof CounterCtx.useSend>;
    expectTypeOf<SendFn>().toEqualTypeOf<(event: CounterEvent) => void>();
  });

  it("useSelector receives typed view", () => {
    const CounterCtx = actorContext<typeof CounterClient>();

    type SelectorArg = Parameters<typeof CounterCtx.useSelector<number>>[0];
    expectTypeOf<SelectorArg>().toEqualTypeOf<(view: { count: number; lastUpdatedBy: string } | undefined) => number>();
  });
});
