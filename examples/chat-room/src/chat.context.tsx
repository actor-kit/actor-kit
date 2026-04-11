// React context with typed hooks, derived from the chat room contract.
// Browser-safe: chat.ts imports from @actor-kit/worker/testing (no cloudflare:workers).

import { actorContext } from "@actor-kit/react";
import { ChatRoomContract } from "./chat";

export const ChatRoomContext = actorContext(ChatRoomContract);
