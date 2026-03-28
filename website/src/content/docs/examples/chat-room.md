---
title: Chat Room
description: Real-time messaging with connect/disconnect lifecycle.
---

The chat room demonstrates WebSocket lifecycle events and real-time broadcast to multiple connected users.

**Source**: [`examples/chat-room/`](https://github.com/actor-kit/actor-kit/tree/main/examples/chat-room)

## What it demonstrates

- `lifecycle.connect` / `lifecycle.disconnect` handlers
- Online user tracking
- Real-time message broadcast to all connected users
- Message history (last 50 messages)
- Contract-derived client: no manual event unions

## Lifecycle Events

```typescript
export const ChatRoomContract = defineActor("chat-room", {
  input: z.object({}),
  init: (): ChatState => ({ messages: [], onlineUsers: [] }),

  roles: {
    user: () => true,
  },

  messages: {
    SEND_MESSAGE: message(
      z.object({ text: z.string().min(1).max(500) }),
      (state: ChatState, { text }, { caller }) => ({
        ...state,
        messages: [
          ...state.messages.slice(-49),
          { id: crypto.randomUUID(), author: caller, text, timestamp: Date.now() },
        ],
      }),
    ),
  },

  views: {
    user: view(ChatViewSchema, (state) => ({
      messages: state.messages.map((m) => ({ id: m.id, author: m.author, text: m.text })),
      onlineCount: state.onlineUsers.length,
    })),
  },

  lifecycle: {
    connect: (state, { caller }) => {
      if (state.onlineUsers.includes(caller)) return state;
      return { ...state, onlineUsers: [...state.onlineUsers, caller] };
    },
    disconnect: (state, { caller }) => ({
      ...state,
      onlineUsers: state.onlineUsers.filter((u) => u !== caller),
    }),
  },
});

export const ChatRoom = createActorClass(ChatRoomContract);
```

When a WebSocket connects, the framework calls `lifecycle.connect` with `{ caller, callerType }`. When it disconnects, `lifecycle.disconnect` fires. Both are transitions — they persist state and broadcast views.

## Message Handling

The `.slice(-49)` keeps the last 50 messages — old messages are discarded to bound state size. Handlers are synchronous — no `async`/`await`.

## The Client

### Vanilla TypeScript

Use `actorClient(contract)` for typed views and events. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

```typescript
import { actorClient } from "actor-kit/client";
import { ChatRoomContract } from "./chat";

// Events and views inferred from the contract
const ChatClient = actorClient(ChatRoomContract);

// Get a token
const { token } = await fetch("/api/token?actorId=general").then(r => r.json());

// Create a runtime connection
const client = ChatClient.create({
  url: `ws://localhost:8787/api/chat-room/general`,
  accessToken: token,
});

// view is typed from the contract's view schemas
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
import { useState, useEffect } from "react";
import { actorClient } from "actor-kit/client";
import { actorContext } from "actor-kit/react";
import { ChatRoomContract } from "./chat";

const ChatClient = actorClient(ChatRoomContract);
const ChatCtx = actorContext(ChatRoomContract);

function ChatApp({ roomId, token }: { roomId: string; token: string }) {
  const [client, setClient] = useState<ReturnType<typeof ChatClient.create> | null>(null);

  useEffect(() => {
    const c = ChatClient.create({
      url: `wss://${location.host}/api/chat-room/${encodeURIComponent(roomId)}`,
      accessToken: token,
    });
    setClient(c);
    return () => c.disconnect();
  }, [roomId, token]);

  if (!client) return null;

  return (
    <ChatCtx.Provider client={client}>
      <ChatRoom />
    </ChatCtx.Provider>
  );
}

function ChatRoom() {
  const view = ChatCtx.useView();   // typed from contract view schemas
  const send = ChatCtx.useSend();   // event types inferred from contract
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

The `lifecycle.connect` and `lifecycle.disconnect` handlers on the actor handle online tracking — the client doesn't need to do anything special. Opening a tab increments the count; closing it decrements.

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

- [Side Effects](/concepts/side-effects/) — lifecycle hooks are part of the side effects system
- [Actors & State](/concepts/actors-and-state/) — how actor state is defined, persisted, and mutated
