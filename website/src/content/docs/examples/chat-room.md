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
- Contract-derived client: no manual message unions

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
    user: view.shared(ChatViewSchema, (state) => ({
      messages: state.messages.map((m) => ({ id: m.id, author: m.author, text: m.text })),
      onlineCount: state.onlineUsers.length,
    })),
  },

  lifecycle: {
    connect: (state, { caller }) => {
      if (state.onlineUsers.includes(caller)) return state;
      return { ...state, onlineUsers: [...state.onlineUsers, caller] };
    },
    disconnect: (state, { caller, callerConnections }) => {
      if (callerConnections > 0) return state; // another tab is still open
      return { ...state, onlineUsers: state.onlineUsers.filter((u) => u !== caller) };
    },
  },
});
export type ChatRoomContract = typeof ChatRoomContract;

```

The server file imports the contract value and creates the DO class:

```typescript
// chat-room.server.ts
import { createActorClass } from "@actor-kit/worker";
import { ChatRoomContract } from "./chat.contract";

export const ChatRoom = createActorClass(ChatRoomContract);
```

When a WebSocket connects, the framework calls `lifecycle.connect` with `{ caller, callerType, callerConnections }`. When it disconnects, `lifecycle.disconnect` fires. Each socket (tab) is its own connection, so both fire once per tab; `callerConnections` is how many sockets that caller still has open after the event, so a user stays online until their last tab closes. Both are transitions — they persist state and broadcast views.

## Message Handling

The `.slice(-49)` keeps the last 50 messages — old messages are discarded to bound state size. Handlers are synchronous — no `async`/`await`.

## The Client

### Vanilla TypeScript

Client code uses `import type` to import the contract — this keeps Zod, handlers, and Cloudflare dependencies out of the browser bundle. Binary delta decoding is handled transparently — the `subscribe` callback always receives the full, merged view:

The Worker authenticates via session cookie and forwards to the DO with `withCallerIdentity()` — caller identity is never taken from URL params:

```typescript
if (url.pathname.startsWith("/api/chat-room/")) {
  const roomId = url.pathname.split("/")[3] ?? "general";
  const { callerId } = resolveCaller(request); // cookie-based
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
  await stub.spawn({ actorId: roomId, caller: "system", callerType: "service", input: {} });
  const stamped = withCallerIdentity(request, { callerId, callerType: "user" });
  return stub.fetch(stamped);
}
```

```typescript
import { actorClient } from "@actor-kit/client";
import type { ChatRoomContract } from "./chat.contract";

// Type-only — no runtime contract value in the bundle
const ChatClient = actorClient<ChatRoomContract>();

// Create a runtime connection — cookies provide caller identity automatically
const client = ChatClient.create({
  path: `/api/chat-room/general`,
  initialView: { role: "user", messages: [], onlineCount: 0 }, // or an SSR snapshot
});
client.connect();

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
import { useState } from "react";
import { actorContext } from "@actor-kit/react";
import type { ChatRoomContract } from "./chat.contract";

// Type-only — no runtime contract value in the bundle
const ChatCtx = actorContext<typeof ChatRoomContract>();

// Server loader: fetch initial snapshot from the DO
export async function loader({ env, params, callerId }: { env: Env; params: { roomId: string }; callerId: string }) {
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(params.roomId));
  await stub.spawn({ actorId: params.roomId, caller: "system", callerType: "service", input: {} });
  const { snapshot } = await stub.getSnapshot(callerId, "user");
  return { roomId: params.roomId, snapshot };
}

function ChatApp({ roomId, snapshot }: { roomId: string; snapshot: { messages: { id: string; author: string; text: string }[]; onlineCount: number } }) {
  // useClient manages the WebSocket lifecycle. initialView seeds useView() so
  // there's no undefined loading state. Auth is via cookies — no callerId prop.
  const client = ChatCtx.useClient({
    path: `/api/chat-room/${roomId}`,
    initialView: { role: "user", ...snapshot },
  });

  return (
    <ChatCtx.Provider client={client}>
      <ChatRoom />
    </ChatCtx.Provider>
  );
}

function ChatRoom() {
  const view = ChatCtx.useView();   // typed from contract view schemas — always defined
  const send = ChatCtx.useSend();   // message types inferred from contract
  const [text, setText] = useState("");

  return (
    <div>
      <div>{view.onlineCount} online</div>
      <div>
        {view.messages.map(m => (
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

The `lifecycle.connect` and `lifecycle.disconnect` handlers on the actor handle online tracking — the client doesn't need to do anything special. A user's first tab adds them to the count; closing their last tab removes them. Extra tabs of the same user do not change it.

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
