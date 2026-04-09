import { createActorClass } from "@actor-kit/worker";
import { CounterContract } from "./counter.contract";

export const Counter = createActorClass(CounterContract);
