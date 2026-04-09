import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("forward() runtime delivery (integration)", () => {
  it("forwards a message to another actor and preserves original caller identity", async () => {
    const sourceId = env.COUNTER.idFromName("fwd-source");
    const source = env.COUNTER.get(sourceId);
    await source.spawn({ actorId: "fwd-source", caller: "u1", callerType: "user", input: {} });

    const targetId = env.COUNTER.idFromName("fwd-target");
    const target = env.COUNTER.get(targetId);
    await target.spawn({ actorId: "fwd-target", caller: "u1", callerType: "user", input: {} });

    // Trigger a forward from source → target
    await source.send("alice", "user", { type: "FORWARD_TO", targetId: "fwd-target" });

    // Allow async drain to complete
    for (let i = 0; i < 20; i++) {
      const snap = await target.getSnapshot("u1", "user");
      if ((snap.snapshot as { count: number }).count === 5) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const targetSnap = await target.getSnapshot("u1", "user");
    expect((targetSnap.snapshot as { count: number }).count).toBe(5);
    // Original caller ("alice") is preserved in the forwarded message
    expect((targetSnap.snapshot as { lastCaller: string }).lastCaller).toBe("alice");
  });
});
