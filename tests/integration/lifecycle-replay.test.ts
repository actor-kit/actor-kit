/**
 * Lifecycle events journal callerConnections (what the handler read), so a multi-tab chat
 * room replays exactly: closing one of two tabs keeps the user online, live and on replay.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatRoomContract } from "./src/example-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function connect(stub: DurableObjectStub, caller: string) {
  const res = await stub.fetch("http://localhost/ws", {
    headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": caller, "X-Actor-Kit-Caller-Type": "user" },
  });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  return ws;
}

async function read(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_i, state) => ({
    journal: readJournal(state.storage.sql),
    snapshot: z.object({ state: z.string() }).parse(state.storage.sql.exec("SELECT state FROM snapshots").one()).state,
  }));
}

async function waitFor<T>(get: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const v = await get();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("lifecycle events carry callerConnections", () => {
  it("a multi-tab chat room journals the counts and replays to the live state", async () => {
    const name = unique("tabs");
    const stub = env.EXAMPLE_CHAT_ROOM.get(env.EXAMPLE_CHAT_ROOM.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
    const tab1 = await connect(stub, "alice");
    const tab2 = await connect(stub, "alice");
    tab1.close(1000, "one tab");
    // The second tab and closing one of two change nothing in chat-room, so they journal nothing.
    await waitFor(
      () => runInDurableObject(stub, (_i, state) => state.getWebSockets().length),
      (open) => open === 1,
    );
    tab2.close(1000, "last tab");
    const { journal, snapshot } = await waitFor(
      () => read(stub),
      (v) => v.journal.events.some((e) => e.causeType === "lifecycle.disconnect"),
    );
    const lifecycle = journal.events.filter((e) => e.causeType.startsWith("lifecycle."));
    expect(lifecycle.map((e) => [e.causeType, e.payload])).toEqual([
      ["lifecycle.connect", { callerConnections: 1 }],
      ["lifecycle.disconnect", { callerConnections: 0 }],
    ]);
    expect(JSON.parse(snapshot).onlineUsers).toEqual([]);
    const { state } = await replayJournal(ChatRoomContract, journal);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
