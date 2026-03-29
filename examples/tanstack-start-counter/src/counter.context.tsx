// React context with typed hooks, derived from the counter contract.
// Browser-safe: counter.ts imports from @actor-kit/worker/testing (no cloudflare:workers).

import { actorContext } from "@actor-kit/react";
import { CounterContract } from "./counter";

export const CounterContext = actorContext(CounterContract);
