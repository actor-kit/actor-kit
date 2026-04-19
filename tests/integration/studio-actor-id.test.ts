import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Studio actor ID naming", () => {
  it("spawn() updates actorId from hex to human name after auto-spawn", async () => {
    const actorName = `named-actor-${Date.now()}`;
    const id = env.COUNTER.idFromName(actorName);
    const stub = env.COUNTER.get(id);

    // First call triggers auto-spawn (sets actorId to hex DO ID)
    const snap1 = await stub.getSnapshot("user-1", "user");
    expect(snap1.snapshot).toBeDefined();

    // Inspect before spawn — actorId should be the hex DO ID
    const inspect1 = (await stub.__inspect()) as { actorId: string };
    expect(inspect1.actorId).toBe(id.toString());

    // Now call spawn with a human-readable actorId
    await stub.spawn({
      actorId: actorName,
      caller: "user-1",
      callerType: "user",
      input: {},
    });

    // Inspect after spawn — actorId should be updated to the human name
    const inspect2 = (await stub.__inspect()) as { actorId: string };
    expect(inspect2.actorId).toBe(actorName);
  });

  it("__inspect actorId reflects the name from spawn()", async () => {
    const actorName = `inspect-name-${Date.now()}`;
    const id = env.COUNTER.idFromName(actorName);
    const stub = env.COUNTER.get(id);

    // spawn() with human name
    await stub.spawn({
      actorId: actorName,
      caller: "user-1",
      callerType: "user",
      input: {},
    });

    const result = (await stub.__inspect()) as { actorId: string };
    expect(result.actorId).toBe(actorName);
  });

  it("actorId persists across loadState after spawn update", async () => {
    const actorName = `persist-name-${Date.now()}`;
    const id = env.COUNTER.idFromName(actorName);

    // First stub — auto-spawn + spawn with name
    const stub1 = env.COUNTER.get(id);
    await stub1.spawn({
      actorId: actorName,
      caller: "user-1",
      callerType: "user",
      input: {},
    });

    // Send a message to persist state with the updated actorId
    await stub1.send("user-1", "user", { type: "INCREMENT", amount: 1 });

    // Get a fresh stub (simulates DO restart / hibernation wake)
    const stub2 = env.COUNTER.get(id);
    const inspect = (await stub2.__inspect()) as { actorId: string };

    // The human name should survive loadState
    expect(inspect.actorId).toBe(actorName);
  });
});
