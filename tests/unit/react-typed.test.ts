import { createActorContext } from "@actor-kit/react";
import { describe, expectTypeOf, it } from "vitest";

type CounterView = { count: number; lastUpdatedBy: string };
type CounterEvent = { type: "INCREMENT" } | { type: "DECREMENT" } | { type: "RESET" };

describe("typed React context", () => {
  it("useView returns typed view", () => {
    const Ctx = createActorContext<CounterView, CounterEvent>();

    expectTypeOf(Ctx.useView).returns.toEqualTypeOf<CounterView | undefined>();
  });

  it("useSend returns typed send function", () => {
    const Ctx = createActorContext<CounterView, CounterEvent>();

    type SendFn = ReturnType<typeof Ctx.useSend>;
    expectTypeOf<SendFn>().toEqualTypeOf<(event: CounterEvent) => void>();
  });

  it("useSelector receives typed view", () => {
    const Ctx = createActorContext<CounterView, CounterEvent>();

    type SelectorArg = Parameters<typeof Ctx.useSelector<number>>[0];
    expectTypeOf<SelectorArg>().toEqualTypeOf<(view: CounterView | undefined) => number>();
  });

  it("createActorContext without generics has unknown view", () => {
    const Ctx = createActorContext();

    expectTypeOf(Ctx.useView).returns.toEqualTypeOf<unknown>();
  });
});
