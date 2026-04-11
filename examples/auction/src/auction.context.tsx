// React context with typed hooks, derived from the auction contract.
// Browser-safe: auction.ts imports from @actor-kit/worker/testing (no cloudflare:workers).

import { actorContext } from "@actor-kit/react";
import { AuctionContract } from "./auction";

export const AuctionContext = actorContext(AuctionContract);
