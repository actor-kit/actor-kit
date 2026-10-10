/**
 * Domain events in a real Durable Object (ADR-017 §2): emitted events are stored on the journal
 * row of the transition that emitted them (a transition that only emits is journaled too), and
 * Studio's timeline shows them.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("domain events (examples/auction)", () => {
  it("are journaled with their transition, and shown on the timeline", async () => {
    const name = `events-${Date.now()}`;
    const stub = env.EXAMPLE_AUCTION.get(env.EXAMPLE_AUCTION.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: { item: "lamp" } });
    await stub.send("alice", "user", { type: "BID", amount: 10 });
    await stub.send("bob", "user", { type: "BID", amount: 5 });
    const events = await runInDurableObject(stub, (_i, state) => readJournal(state.storage.sql).events);
    expect(events.map((e) => [e.seq, e.emitted])).toEqual([
      [1, undefined],
      [2, [{ name: "BidPlaced", payload: { bidder: "alice", amount: 10 } }]],
      [3, [{ name: "BidIgnored", payload: { bidder: "bob", amount: 5, reason: "too_low" } }]],
    ]);
    const { entries } = await stub.__getTimeline({ limit: 1 });
    expect(JSON.parse(entries[0]?.emitted ?? "null")).toEqual([
      { name: "BidIgnored", payload: { bidder: "bob", amount: 5, reason: "too_low" } },
    ]);
  });
});
