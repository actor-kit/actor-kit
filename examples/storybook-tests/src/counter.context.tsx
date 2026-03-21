import { createActorKitContext } from "@actor-kit/react";
import type { CounterView, CounterClientEvent } from "./counter.machine";

export const CounterContext = createActorKitContext<CounterView, CounterClientEvent>("counter");
