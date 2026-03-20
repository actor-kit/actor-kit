import { createActorKitContext } from "@actor-kit/react";
import type { CounterMachine } from "./counter.machine";

export const CounterContext = createActorKitContext<CounterMachine>("counter");
