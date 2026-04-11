// Cloudflare Worker entry — exports the Auction Durable Object class.
// Nitro merges this with its server handler for the final Worker module.

import { createActorClass } from "@actor-kit/worker";
import { AuctionContract } from "./auction";

export const Auction = createActorClass(AuctionContract);
