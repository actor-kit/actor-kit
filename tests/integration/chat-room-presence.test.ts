/**
 * examples/chat-room presence with several tabs per user.
 *
 * Each socket is its own connection, so lifecycle connect/disconnect fire per
 * socket. A user must stay in `onlineUsers` until their LAST tab closes.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const InspectSchema = z.object({
  state: z.object({ onlineUsers: z.array(z.string()) }),
  connections: z.array(z.object({ connectionId: z.string(), caller: z.string() })),
});

let seq = 0;
async function spawnRoom() {
  seq += 1;
  const name = `presence-${Date.now()}-${seq}`;
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(name));
  await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
  return stub;
}

type Room = Awaited<ReturnType<typeof spawnRoom>>;

async function inspect(stub: Room) {
  return InspectSchema.parse(await stub.__inspect());
}

async function openTab(stub: Room, caller: string): Promise<WebSocket> {
  const res = await stub.fetch("http://localhost/ws", {
    headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": caller, "X-Actor-Kit-Caller-Type": "user" },
  });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`upgrade failed for ${caller}: ${res.status}`);
  ws.accept();
  return ws;
}

/** Polls until the DO holds exactly `count` app sockets (so every close/connect has been handled). */
async function untilSockets(stub: Room, count: number) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const snapshot = await inspect(stub);
    if (snapshot.connections.length === count) return snapshot;
    if (Date.now() > deadline) throw new Error(`expected ${count} sockets, have ${snapshot.connections.length}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("chat-room presence across tabs (integration)", () => {
  it("keeps alice online when she closes one of two tabs, and drops her when the last one closes", async () => {
    const stub = await spawnRoom();
    const tab1 = await openTab(stub, "alice");
    const tab2 = await openTab(stub, "alice");
    expect((await untilSockets(stub, 2)).state.onlineUsers).toEqual(["alice"]);

    tab1.close(1000, "tab closed");
    expect((await untilSockets(stub, 1)).state.onlineUsers).toEqual(["alice"]);

    tab2.close(1000, "tab closed");
    expect((await untilSockets(stub, 0)).state.onlineUsers).toEqual([]);
  });

  it("one user's closed tab does not affect another user", async () => {
    const stub = await spawnRoom();
    const alice1 = await openTab(stub, "alice");
    await openTab(stub, "alice");
    const bob = await openTab(stub, "bob");
    expect((await untilSockets(stub, 3)).state.onlineUsers).toEqual(["alice", "bob"]);

    alice1.close(1000, "tab closed");
    expect((await untilSockets(stub, 2)).state.onlineUsers).toEqual(["alice", "bob"]);

    bob.close(1000, "tab closed");
    expect((await untilSockets(stub, 1)).state.onlineUsers).toEqual(["alice"]);
  });

  it("the view's onlineCount counts users, not tabs", async () => {
    const stub = await spawnRoom();
    await openTab(stub, "alice");
    await openTab(stub, "alice");
    await openTab(stub, "bob");
    await untilSockets(stub, 3);
    const { snapshot } = await stub.getSnapshot("carol", "user");
    expect(z.object({ onlineCount: z.number() }).parse(snapshot).onlineCount).toBe(2);
  });
});
