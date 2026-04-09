import { createActorClass } from "@actor-kit/worker";
import { AuctionContract } from "./auction.contract";

export const Auction = createActorClass(AuctionContract);
