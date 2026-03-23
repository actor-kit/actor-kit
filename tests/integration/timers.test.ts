import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("DO Alarm (after timers) — integration", () => {
  it("alarm() transitions state when fired", async () => {
    const id = env.TIMER_ACTOR.idFromName("timer-alarm-1");
    const stub = env.TIMER_ACTOR.get(id);

    await stub.spawn({ actorId: "timer-alarm-1", caller: "u1", callerType: "user", input: {} });

    // Before alarm: expired should be false
    const before = await stub.getSnapshot("u1", "user");
    expect((before.snapshot as { expired: boolean }).expired).toBe(false);

    // Trigger the alarm (simulates DO Alarm firing)
    const alarmRan = await runDurableObjectAlarm(stub);
    expect(alarmRan).toBe(true);

    // After alarm: expired should be true
    const after = await stub.getSnapshot("u1", "user");
    expect((after.snapshot as { expired: boolean }).expired).toBe(true);
  });

  it("state persists after alarm fires", async () => {
    const id = env.TIMER_ACTOR.idFromName("timer-alarm-persist");
    const stub = env.TIMER_ACTOR.get(id);

    await stub.spawn({ actorId: "timer-alarm-persist", caller: "u1", callerType: "user", input: {} });
    await runDurableObjectAlarm(stub);

    // Get a new stub (simulate restart)
    const stub2 = env.TIMER_ACTOR.get(id);
    const snapshot = await stub2.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { expired: boolean }).expired).toBe(true);
  });

  it("messages still work after alarm fires", async () => {
    const id = env.TIMER_ACTOR.idFromName("timer-alarm-msg");
    const stub = env.TIMER_ACTOR.get(id);

    await stub.spawn({ actorId: "timer-alarm-msg", caller: "u1", callerType: "user", input: {} });
    await runDurableObjectAlarm(stub);

    // Send INCREMENT after alarm
    const result = await stub.send("u1", "user", { type: "INCREMENT" });
    expect(result.ok).toBe(true);

    const snapshot = await stub.getSnapshot("u1", "user");
    expect((snapshot.snapshot as { count: number }).count).toBe(1);
    expect((snapshot.snapshot as { expired: boolean }).expired).toBe(true);
  });
});
