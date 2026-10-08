/**
 * The auction and chat-room example scenarios (examples/<name>/e2e and the chat-room presence
 * test) on simulate(): real contracts, many callers, the step core, verified journals. These run
 * in milliseconds without the Workers runtime or a browser.
 */
import { replayJournal, simulate } from "@actor-kit/test";
import { describe, expect, it } from "vitest";
import { AuctionContract } from "../../examples/auction/src/auction";
import { ChatRoomContract } from "../../examples/chat-room/src/chat";

describe("auction (examples/auction)", () => {
  async function auction() {
    const sim = simulate({ contracts: [AuctionContract], seed: 1, now: 1_000 });
    const room = await sim.spawn(AuctionContract, "lamp-sale", { item: "lamp" });
    return { sim, room };
  }

  it("starts with the item and no bids", async () => {
    const { room } = await auction();
    expect(room.view("alice")).toEqual({ item: "lamp", bidCount: 0, highestBid: 0, closed: false, winner: null });
  });

  it("a bid updates the highest bid and the count, stamped with ctx.now()", async () => {
    const { sim, room } = await auction();
    sim.advance("5s");
    expect(room.send("alice", { type: "BID", amount: 10 })).toEqual({ ok: true });
    expect(room.view("alice")).toMatchObject({ bidCount: 1, highestBid: 10 });
    expect(room.state.bids).toEqual([{ bidder: "alice", amount: 10, timestamp: 6_000 }]);
  });

  it("a higher bid replaces a lower one; a lower or equal bid is ignored", async () => {
    const { room } = await auction();
    room.send("alice", { type: "BID", amount: 10 });
    room.send("bob", { type: "BID", amount: 25 });
    room.send("carol", { type: "BID", amount: 25 });
    room.send("dave", { type: "BID", amount: 5 });
    expect(room.view("alice")).toMatchObject({ bidCount: 2, highestBid: 25 });
  });

  it("two bidders see each other's bids", async () => {
    const { room } = await auction();
    room.send("alice", { type: "BID", amount: 10 });
    room.send("bob", { type: "BID", amount: 20 });
    expect(room.view("alice")).toEqual(room.view("bob"));
    expect(room.view("alice")).toMatchObject({ bidCount: 2, highestBid: 20 });
  });

  it("only the auctioneer (a service caller) can close, and only with bids", async () => {
    const { room } = await auction();
    expect(room.role("ops", { callerType: "service" })).toBe("auctioneer");
    expect(room.send("ops", { type: "CLOSE" }, { callerType: "service" })).toEqual({
      ok: false,
      error: "guard_failed",
    });
    room.send("alice", { type: "BID", amount: 10 });
    expect(room.send("alice", { type: "CLOSE" })).toEqual({ ok: false, error: "guard_failed" });
    expect(room.send("ops", { type: "CLOSE" }, { callerType: "service" })).toEqual({ ok: true });
    expect(room.view("alice")).toMatchObject({ closed: true, winner: "alice" });
    expect(room.send("bob", { type: "BID", amount: 99 })).toEqual({ ok: false, error: "guard_failed" });
  });

  it("the bids persist: the journal replays to the same state", async () => {
    const { room } = await auction();
    room.send("alice", { type: "BID", amount: 10 });
    room.send("bob", { type: "BID", amount: 20 });
    const { state } = await replayJournal(AuctionContract, room.journal);
    expect(state).toEqual(room.state);
  });

  it("branches explore two endings of the same auction", async () => {
    const { sim, room } = await auction();
    room.send("alice", { type: "BID", amount: 10 });
    const outbid = sim.branch();
    outbid.actor(AuctionContract, "lamp-sale").send("bob", { type: "BID", amount: 50 });
    for (const world of [sim, outbid]) {
      world.actor(AuctionContract, "lamp-sale").send("ops", { type: "CLOSE" }, { callerType: "service" });
    }
    expect(room.state.winner).toBe("alice");
    expect(outbid.actor(AuctionContract, "lamp-sale").state.winner).toBe("bob");
  });
});

describe("chat room (examples/chat-room)", () => {
  async function chat() {
    const sim = simulate({ contracts: [ChatRoomContract], seed: 3, now: 0 });
    const room = await sim.spawn(ChatRoomContract, "lobby", {});
    return { sim, room };
  }

  it("a user can send a message; ids come from the seeded ctx.id()", async () => {
    const { room } = await chat();
    expect(room.send("alice", { type: "SEND_MESSAGE", text: "hi" })).toEqual({ ok: true });
    const [message] = room.state.messages;
    expect(message).toMatchObject({ author: "alice", text: "hi", timestamp: 0 });
    expect(message?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the same seed gives the same message ids", async () => {
    const ids = async () => {
      const { room } = await chat();
      room.send("alice", { type: "SEND_MESSAGE", text: "a" });
      room.send("bob", { type: "SEND_MESSAGE", text: "b" });
      return room.state.messages.map((m) => m.id);
    };
    expect(await ids()).toEqual(await ids());
  });

  it("refuses an empty message", async () => {
    const { room } = await chat();
    expect(room.send("alice", { type: "SEND_MESSAGE", text: "" })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
  });

  it("two users see each other's messages", async () => {
    const { room } = await chat();
    room.send("alice", { type: "SEND_MESSAGE", text: "hello" });
    room.send("bob", { type: "SEND_MESSAGE", text: "hey" });
    const view = room.view("alice");
    expect(view).toEqual(room.view("bob"));
    expect(view).toMatchObject({
      messages: [
        { author: "alice", text: "hello" },
        { author: "bob", text: "hey" },
      ],
    });
  });

  it("presence is per user across tabs: online until the last tab closes", async () => {
    const { room } = await chat();
    const aliceTab1 = room.connect("alice");
    const aliceTab2 = room.connect("alice");
    const bob = room.connect("bob");
    expect(room.state.onlineUsers).toEqual(["alice", "bob"]);
    aliceTab1.disconnect();
    expect(room.state.onlineUsers).toEqual(["alice", "bob"]);
    aliceTab2.disconnect();
    expect(room.state.onlineUsers).toEqual(["bob"]);
    bob.disconnect();
    expect(room.view("x")).toMatchObject({ onlineCount: 0 });
  });

  it("the multi-tab journal replays exactly (callerConnections is journaled)", async () => {
    const { room } = await chat();
    const tab1 = room.connect("alice");
    const tab2 = room.connect("alice");
    room.send("alice", { type: "SEND_MESSAGE", text: "two tabs" });
    tab1.disconnect();
    tab2.disconnect();
    const { state } = await replayJournal(ChatRoomContract, room.journal);
    expect(state).toEqual(room.state);
  });
});
