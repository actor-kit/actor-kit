import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAccessToken } from "../../packages/actor-kit/src/auth/auth";

const SECRET = "test-secret-for-integration-tests-only";

describe("Tick game loop (integration)", () => {
  it("tick increments count while WebSocket is connected", async () => {
    const actorId = "tick-1";
    const id = env.TIMER_ACTOR.idFromName(actorId);
    const stub = env.TIMER_ACTOR.get(id);
    await stub.spawn({ actorId, caller: "u1", callerType: "user", input: {} });

    // Before connecting — count should be 0
    const before = await stub.getSnapshot("u1", "user");
    expect((before.snapshot as { count: number }).count).toBe(0);

    // Connect via WebSocket (this starts the tick)
    const token = await createAccessToken({
      actorType: "timer",
      actorId,
      callerId: "u1",
      callerType: "user",
      secret: SECRET,
    });

    const response = await stub.fetch(`http://localhost/api/timer/${actorId}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `token.${token}`,
      },
    });

    const ws = response.webSocket!;
    ws.accept();

    // Wait for ticks to fire (50ms frequency, wait 200ms for ~4 ticks)
    await new Promise((r) => setTimeout(r, 200));

    // Check count increased
    const after = await stub.getSnapshot("u1", "user");
    const count = (after.snapshot as { count: number }).count;
    expect(count).toBeGreaterThan(0);

    ws.close(1000);
    await new Promise((r) => setTimeout(r, 50));
  }, 10000); // 10s timeout for this test
});
