import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Sequential states (integration)", () => {
  it("actor starts in initial state and accepts messages for that state", async () => {
    const id = env.AUCTION.idFromName("states-1");
    const stub = env.AUCTION.get(id);
    await stub.spawn({ actorId: "states-1", caller: "u1", callerType: "user", input: {} });

    // In "bidding" state — BID should work
    const result = await stub.send("u1", "user", { type: "BID", amount: 100 });
    expect(result.ok).toBe(true);

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { bidCount: number }).bidCount).toBe(1);
  });

  it("multiple bids work in bidding state", async () => {
    const id = env.AUCTION.idFromName("states-2");
    const stub = env.AUCTION.get(id);
    await stub.spawn({ actorId: "states-2", caller: "u1", callerType: "user", input: {} });

    await stub.send("u1", "user", { type: "BID", amount: 50 });
    await stub.send("u1", "user", { type: "BID", amount: 75 });
    await stub.send("u1", "user", { type: "BID", amount: 100 });

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { bidCount: number }).bidCount).toBe(3);
  });

  it("CLOSE works in bidding state", async () => {
    const id = env.AUCTION.idFromName("states-3");
    const stub = env.AUCTION.get(id);
    await stub.spawn({ actorId: "states-3", caller: "u1", callerType: "user", input: {} });

    await stub.send("u1", "user", { type: "BID", amount: 100 });
    const result = await stub.send("u1", "user", { type: "CLOSE" });
    expect(result.ok).toBe(true);
  });
});
