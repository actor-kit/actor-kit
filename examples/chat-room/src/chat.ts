// Chat room actor contract — browser-safe (imports from @actor-kit/worker/testing, no cloudflare:workers).
// Used by both server (SSR loader, DO class) and client (typed React context, typed client).

import { z } from "zod";
import { array, schema, string, uint32, view } from "@actor-kit/core";
import { defineActor, message } from "@actor-kit/worker/testing";

type ChatMessage = { id: string; author: string; text: string; timestamp: number };
type ChatState = {
  messages: ChatMessage[];
  onlineUsers: string[];
};

const MessageSchema = schema({ id: string, author: string, text: string });
const ChatViewSchema = schema({
  messages: array(MessageSchema),
  onlineCount: uint32,
});

export const ChatRoomContract = defineActor("chat-room", {
  input: z.object({}),
  init: (): ChatState => ({ messages: [], onlineUsers: [] }),

  roles: {
    user: () => true,
  },

  messages: {
    SEND_MESSAGE: message(
      z.object({ text: z.string().min(1).max(500) }),
      (state: ChatState, { text }, { caller, id, now }) => ({
        ...state,
        messages: [
          ...state.messages.slice(-49), // Keep last 50 messages
          { id: id(), author: caller, text, timestamp: now() },
        ],
      }),
    ),
  },

  views: {
    user: view.shared(ChatViewSchema, (state: ChatState) => ({
      messages: state.messages.map((m) => ({
        id: m.id,
        author: m.author,
        text: m.text,
      })),
      onlineCount: state.onlineUsers.length,
    })),
  },

  studio: { enabled: true },

  lifecycle: {
    connect: (
      state: ChatState,
      { caller }: { caller: string; callerType: "user" | "service" },
    ) => {
      if (state.onlineUsers.includes(caller)) return state;
      return { ...state, onlineUsers: [...state.onlineUsers, caller] };
    },
    disconnect: (
      state: ChatState,
      { caller }: { caller: string; callerType: "user" | "service" },
    ) => ({
      ...state,
      onlineUsers: state.onlineUsers.filter((u) => u !== caller),
    }),
  },
});

export type ChatRoomContract = typeof ChatRoomContract;
