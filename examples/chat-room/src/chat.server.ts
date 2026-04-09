import { createActorClass } from "@actor-kit/worker";
import { ChatRoomContract } from "./chat.contract";

export const ChatRoom = createActorClass(ChatRoomContract);
