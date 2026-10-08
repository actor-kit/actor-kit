/**
 * The example apps' actor contracts, hosted in the integration Worker so their journals can be
 * replayed (tests/integration/examples-replay.test.ts, ADR-013 step 2).
 */

import { createActorClass } from "@actor-kit/worker";
import { AuctionContract } from "../../../examples/auction/src/auction";
import { ChatRoomContract } from "../../../examples/chat-room/src/chat";
import { CounterContract } from "../../../examples/counter/src/counter";
import { TodoListContract } from "../../../examples/todo-list/src/todo";

export { AuctionContract, ChatRoomContract, CounterContract, TodoListContract };

export const ExampleAuction = createActorClass(AuctionContract);
export const ExampleChatRoom = createActorClass(ChatRoomContract);
export const ExampleCounter = createActorClass(CounterContract);
export const ExampleTodoList = createActorClass(TodoListContract);
