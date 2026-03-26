import { z } from "zod";
import { array, schema, string, uint32, view } from "@actor-kit/core";
import { actor, message } from "@actor-kit/worker";

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

const sendMessage = message(
  z.object({ text: z.string().min(1).max(500) }),
  (state: ChatState, { text }, { caller }) => ({
    ...state,
    messages: [
      ...state.messages.slice(-49), // Keep last 50 messages
      { id: crypto.randomUUID(), author: caller, text, timestamp: Date.now() },
    ],
  }),
);

export const ChatRoom = actor("chat-room", {
  input: z.object({}),
  init: (): ChatState => ({ messages: [], onlineUsers: [] }),

  roles: {
    user: () => true,
  },

  messages: {
    user: { SEND_MESSAGE: sendMessage },
  },

  views: {
    user: view(ChatViewSchema, (state: ChatState) => ({
      messages: state.messages.map((m) => ({
        id: m.id,
        author: m.author,
        text: m.text,
      })),
      onlineCount: state.onlineUsers.length,
    })),
  },

  on: {
    connect: (state: unknown, caller: unknown) => {
      const s = state as ChatState;
      const c = caller as string;
      if (s.onlineUsers.includes(c)) return s;
      return { ...s, onlineUsers: [...s.onlineUsers, c] };
    },
    disconnect: (state: unknown, caller: unknown) => {
      const s = state as ChatState;
      const c = caller as string;
      return { ...s, onlineUsers: s.onlineUsers.filter((u) => u !== c) };
    },
  },
});
