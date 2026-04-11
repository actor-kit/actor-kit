// Cloudflare Worker entry — exports the ChatRoom Durable Object class.
// Nitro merges this with its server handler for the final Worker module.

import { createActorClass } from "@actor-kit/worker";
import { ChatRoomContract } from "./chat";

export const ChatRoom = createActorClass(ChatRoomContract);
