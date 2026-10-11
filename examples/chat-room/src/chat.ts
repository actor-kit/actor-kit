// Chat room actor contract — browser-safe (imports from @actor-kit/worker/testing, no cloudflare:workers).
// Used by both server (SSR loader, DO class) and client (typed React context, typed client).

import { z } from "zod";
import { array, schema, string, uint32, view } from "@actor-kit/core";
import { type LifecycleEvent, setup } from "@actor-kit/worker/testing";

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

/** The kit (ADR-018 A): this actor declares no events, states or env, so it is empty. */
const chat = setup({});

export const ChatRoomContract = chat.actor("chat-room", {
  input: z.object({}),
  init: (): ChatState => ({ messages: [], onlineUsers: [] }),

  roles: {
    user: () => true,
  },

  messages: {
    SEND_MESSAGE: chat.message(
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

  // Lifecycle fires per socket, so a user with two tabs connects twice.
  // They stay online until their last tab closes (callerConnections === 0).
  lifecycle: {
    connect: (state: ChatState, { caller }: LifecycleEvent) => {
      if (state.onlineUsers.includes(caller)) return state;
      return { ...state, onlineUsers: [...state.onlineUsers, caller] };
    },
    disconnect: (state: ChatState, { caller, callerConnections }: LifecycleEvent) => {
      if (callerConnections > 0) return state;
      return { ...state, onlineUsers: state.onlineUsers.filter((u) => u !== caller) };
    },
  },
});

export type ChatRoomContract = typeof ChatRoomContract;
