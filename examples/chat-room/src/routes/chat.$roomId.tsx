import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { ChatRoomContext } from "../chat.context";
import { ChatRoomDisplay } from "../components/ChatRoom";
import { getActorRuntimeEnv } from "../server-env";
import { useState } from "react";

const ChatRouteInputSchema = z.object({
  roomId: z.string().min(1),
});

// Parse the DO snapshot at the server function boundary.
const ViewSnapshotSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      text: z.string(),
    }),
  ),
  onlineCount: z.number(),
});

// Server function: fetch initial snapshot from the Durable Object.
// Runs on the Worker — has direct access to DO bindings.
const loadChatRoom = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => ChatRouteInputSchema.parse(input))
  .handler(async ({ data }) => {
    const env = getActorRuntimeEnv();
    const roomId = data.roomId;

    // Persist a caller_id on first visit so the WS upgrade presents the same
    // identity (the middleware reads it). Demo-only: production would use a
    // signed session cookie or JWT.
    if (getCookie("caller_id") === undefined) {
      setCookie("caller_id", `user-${crypto.randomUUID().slice(0, 8)}`, {
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    const doId = env.CHAT_ROOM.idFromName(roomId);
    const stub = env.CHAT_ROOM.get(doId);

    // Spawn idempotently with system caller
    await stub.spawn({
      actorId: roomId,
      caller: "system",
      callerType: "service",
      input: {},
    });

    // Get snapshot for the demo user — parse at the boundary
    const result = await stub.getSnapshot("demo-user", "user");
    const snapshot = ViewSnapshotSchema.parse(result.snapshot);

    return { roomId, snapshot };
  });

export const Route = createFileRoute("/chat/$roomId")({
  loader: ({ params }) => loadChatRoom({ data: params }),
  component: ChatRouteComponent,
});

function ChatRouteComponent() {
  const { roomId, snapshot } = Route.useLoaderData();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 rounded-3xl bg-white p-10 shadow-sm">
        <div className="flex w-full items-center justify-between">
          <p className="text-sm font-medium uppercase tracking-wider text-[var(--sea-ink-soft)]">
            Live Chat
          </p>
          <Link
            to="/"
            className="text-sm font-medium text-[var(--lagoon-deep)] hover:underline"
          >
            Home
          </Link>
        </div>
        <ChatRoomLive roomId={roomId} initialSnapshot={snapshot} />
      </section>
    </main>
  );
}

// Client component: creates a WebSocket client via useClient() and provides it
// through the typed context. The SSR snapshot is the initial view until the
// WebSocket delivers live state.
function ChatRoomLive({
  roomId,
  initialSnapshot,
}: {
  roomId: string;
  initialSnapshot: {
    messages: { id: string; author: string; text: string }[];
    onlineCount: number;
  };
}) {
  const client = ChatRoomContext.useClient({
    path: `/api/chat-room/${roomId}`,
    initialView: { role: "user", ...initialSnapshot },
  });

  return (
    <ChatRoomContext.Provider client={client}>
      <ChatRoomWithHooks />
    </ChatRoomContext.Provider>
  );
}

// Reads live state from the actor client via typed hooks.
function ChatRoomWithHooks() {
  const view = ChatRoomContext.useView();
  const send = ChatRoomContext.useSend();
  const [inputValue, setInputValue] = useState("");

  const handleSend = (text: string) => {
    send({ type: "SEND_MESSAGE", text });
    setInputValue("");
  };

  return (
    <ChatRoomDisplay
      messages={view.messages}
      onlineCount={view.onlineCount}
      currentUser="demo-user"
      inputValue={inputValue}
      onInputChange={setInputValue}
      onSend={handleSend}
    />
  );
}
