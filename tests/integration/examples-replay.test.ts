/**
 * ADR-013 step 2: every example actor's journal, written by a real DO, replays to the same
 * state through replayJournal(). A handler that reads the clock or RNG directly fails here.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuctionContract, ChatRoomContract, CounterContract, TodoListContract } from "./src/example-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Replay the DO's journal and check it lands on the persisted snapshot. */
async function expectReplayable(stub: DurableObjectStub, contract: { name: string; def: unknown }) {
  const { journal, snapshot } = await runInDurableObject(stub, (_instance, state) => ({
    journal: readJournal(state.storage.sql),
    snapshot: z.object({ state: z.string() }).parse(state.storage.sql.exec("SELECT state FROM snapshots").one()).state,
  }));
  const result = await replayJournal(contract, journal);
  expect(result.replayed).toBe(journal.events.length);
  expect(JSON.stringify(result.state)).toBe(snapshot);
  return journal;
}

async function connect(stub: DurableObjectStub, caller: string) {
  const res = await stub.fetch("http://localhost/ws", {
    headers: { Upgrade: "websocket", "X-Actor-Kit-Caller-Id": caller, "X-Actor-Kit-Caller-Type": "user" },
  });
  const ws = res.webSocket;
  if (ws === null) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  return ws;
}

describe("example actors replay their journals exactly", () => {
  it("counter", async () => {
    const name = unique("ex-counter");
    const stub = env.EXAMPLE_COUNTER.get(env.EXAMPLE_COUNTER.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
    await stub.send("alice", "user", { type: "INCREMENT" });
    await stub.send("bob", "user", { type: "INCREMENT" });
    await stub.send("alice", "user", { type: "DECREMENT" });
    await stub.send("svc", "service", { type: "RESET" });
    await stub.send("bob", "user", { type: "INCREMENT" });
    const journal = await expectReplayable(stub, CounterContract);
    expect(journal.events).toHaveLength(6);
  });

  it("chat-room", async () => {
    const name = unique("ex-chat");
    const stub = env.EXAMPLE_CHAT_ROOM.get(env.EXAMPLE_CHAT_ROOM.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
    const ws = await connect(stub, "alice");
    await stub.send("alice", "user", { type: "SEND_MESSAGE", text: "hi" });
    await stub.send("bob", "user", { type: "SEND_MESSAGE", text: "hey alice" });
    ws.close(1000, "bye");
    await settle();
    const journal = await expectReplayable(stub, ChatRoomContract);
    expect(journal.events.map((e) => e.causeType)).toEqual([
      "init",
      "lifecycle.connect",
      "message",
      "message",
      "lifecycle.disconnect",
    ]);
  });

  it("todo-list", async () => {
    const name = unique("ex-todo");
    const stub = env.EXAMPLE_TODO_LIST.get(env.EXAMPLE_TODO_LIST.idFromName(name));
    await stub.spawn({ actorId: name, caller: "olive", callerType: "user", input: { creator: "olive" } });
    await stub.send("olive", "user", { type: "ADD_TODO", text: "milk" });
    await stub.send("olive", "user", { type: "ADD_TODO", text: "eggs" });
    await stub.send("olive", "user", { type: "INVITE", userId: "bob" });
    const view = z
      .object({ todos: z.array(z.object({ id: z.string() })) })
      .parse((await stub.getSnapshot("olive", "user")).snapshot);
    const [first, second] = view.todos;
    await stub.send("bob", "user", { type: "TOGGLE", id: first?.id ?? "" });
    await stub.send("olive", "user", { type: "DELETE_TODO", id: second?.id ?? "" });
    const journal = await expectReplayable(stub, TodoListContract);
    expect(journal.events).toHaveLength(6);
  });

  it("auction", async () => {
    const name = unique("ex-auction");
    const stub = env.EXAMPLE_AUCTION.get(env.EXAMPLE_AUCTION.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: { item: "lamp" } });
    await stub.send("alice", "user", { type: "BID", amount: 10 });
    await stub.send("bob", "user", { type: "BID", amount: 20 });
    await stub.send("alice", "user", { type: "BID", amount: 15 });
    await stub.send("svc", "service", { type: "CLOSE" });
    const journal = await expectReplayable(stub, AuctionContract);
    expect(journal.events).toHaveLength(5);
  });
});
