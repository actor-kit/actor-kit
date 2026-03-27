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
- Client rendering from snapshot data

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

## The Client

### Vanilla TypeScript

Use `actorClient()` for typed views and events. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

```typescript
import { actorClient } from "@actor-kit/client";

type ChatEvent = { type: "SEND_MESSAGE"; text: string };

const ChatClient = actorClient(ChatViewSchema).events<ChatEvent>();

// Get a token
const { token } = await fetch("/api/token?actorId=general").then(r => r.json());

// Create a runtime connection
const client = ChatClient.create({
  url: `ws://localhost:8787/api/chat-room/general`,
  accessToken: token,
});

// view is typed from ChatViewSchema
client.subscribe((view) => {
  document.getElementById("online")!.textContent = `${view.onlineCount} online`;
  document.getElementById("messages")!.innerHTML = view.messages
    .map(m => `<div><b>${m.author}</b>: ${m.text}</div>`)
    .join("");
});

client.send({ type: "SEND_MESSAGE", text: "Hello!" });
```

### React

```tsx
import { actorClient } from "@actor-kit/client";
import { actorContext } from "@actor-kit/react";

type ChatEvent = { type: "SEND_MESSAGE"; text: string };

const ChatClient = actorClient(ChatViewSchema).events<ChatEvent>();
const ChatCtx = actorContext<typeof ChatClient>();

function ChatApp({ roomId, token }: { roomId: string; token: string }) {
  const client = ChatClient.create({
    url: `wss://${location.host}/api/chat-room/${encodeURIComponent(roomId)}`,
    accessToken: token,
  });

  return (
    <ChatCtx.Provider client={client}>
      <ChatRoom />
    </ChatCtx.Provider>
  );
}

function ChatRoom() {
  const view = ChatCtx.useView();   // typed from ChatViewSchema
  const send = ChatCtx.useSend();   // (event: ChatEvent) => void
  const [text, setText] = useState("");

  return (
    <div>
      <div>{view?.onlineCount ?? 0} online</div>
      <div>
        {view?.messages.map(m => (
          <div key={m.id}><b>{m.author}</b>: {m.text}</div>
        ))}
      </div>
      <input value={text} onChange={e => setText(e.target.value)} />
      <button onClick={() => { send({ type: "SEND_MESSAGE", text }); setText(""); }}>
        Send
      </button>
    </div>
  );
}
```

The `on.connect` and `on.disconnect` lifecycle hooks on the actor handle online tracking — the client doesn't need to do anything special. Opening a tab increments the count; closing it decrements.

## Try it

```bash
cd examples/chat-room
pnpm install
pnpm dev
# Open http://localhost:8787?user=alice
# Open http://localhost:8787?user=bob
# Both see messages in real-time + online count
```

## Related

- [Side Effects](/concepts/side-effects/) — lifecycle hooks like `on.connect` and `on.disconnect` are part of the side effects system
- [Actors & State](/concepts/actors-and-state/) — how actor state is defined, persisted, and mutated
