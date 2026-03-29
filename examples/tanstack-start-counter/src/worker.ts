// Cloudflare Worker entry — exports the Counter Durable Object class.
// Nitro merges this with its server handler for the final Worker module.

import { createActorClass } from "@actor-kit/worker";
import { CounterContract } from "./counter";

export const Counter = createActorClass(CounterContract);
