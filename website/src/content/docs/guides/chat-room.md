---
title: Chat Room
description: Real-time messaging with connect/disconnect lifecycle.
---

The chat room demonstrates WebSocket lifecycle events and real-time broadcast to multiple connected users.

**Source**: [`examples/chat-room/`](https://github.com/actor-kit/actor-kit/tree/main/examples/chat-room)

## What it demonstrates

- `on.connect` / `on.disconnect` lifecycle hooks
- Online user tracking
- Real-time message broadcast to all connected users
- Message history (last 50 messages)

## Lifecycle Events

```typescript
on: {
  connect: (state, caller) => {
    if (state.onlineUsers.includes(caller)) return state;
    return { ...state, onlineUsers: [...state.onlineUsers, caller] };
  },
  disconnect: (state, caller) => ({
    ...state,
    onlineUsers: state.onlineUsers.filter(u => u !== caller),
  }),
},
```

When a WebSocket connects, the framework calls `on.connect` with the caller identity. When it disconnects, `on.disconnect` fires. Both are transitions — they persist state and broadcast views.

## Message Handling

```typescript
const sendMessage = message(
  z.object({ text: z.string().min(1).max(500) }),
  (state, { text }, { caller }) => ({
    ...state,
    messages: [
      ...state.messages.slice(-49),  // Keep last 50
      { id: crypto.randomUUID(), author: caller, text, timestamp: Date.now() },
    ],
  }),
);
```

The `.slice(-49)` keeps the last 50 messages — old messages are discarded to bound state size.

## Try it

```bash
cd examples/chat-room
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice
# Open http://localhost:8787?user=bob
# Both see messages in real-time + online count
```
