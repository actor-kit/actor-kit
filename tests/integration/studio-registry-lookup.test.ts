/**
 * StudioRegistry.hasActor(): the exact lookup the Studio middleware does before contacting an
 * actor DO. An actor is found by its registered name or by its DO hex id, including after
 * spawn() re-keyed its row from the hex id to the name.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const HEX = "a".repeat(64);
const OTHER_HEX = "b".repeat(64);

function freshRegistry() {
  return env.STUDIO_REGISTRY.get(env.STUDIO_REGISTRY.idFromName(`lookup-${crypto.randomUUID()}`));
}

describe("StudioRegistry.hasActor", () => {
  it("finds an actor by its registered id and not under another type", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "room-1", 1);
    expect(await registry.hasActor("counter", "room-1")).toBe(true);
    expect(await registry.hasActor("chat", "room-1")).toBe(false);
    expect(await registry.hasActor("counter", "room-2")).toBe(false);
  });

  it("finds a named actor by the DO id it reported", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "room-1", 1, undefined, HEX);
    expect(await registry.hasActor("counter", HEX)).toBe(true);
    expect(await registry.hasActor("counter", OTHER_HEX)).toBe(false);
  });

  it("still finds a re-keyed actor by its DO id (auto-spawn under hex, then spawn() names it)", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", HEX, 1, undefined, HEX);
    await registry.touch("counter", "named", 1, HEX, HEX);
    expect(await registry.hasActor("counter", "named")).toBe(true);
    expect(await registry.hasActor("counter", HEX)).toBe(true);
    const rows = await registry.listActors({ type: "counter" });
    expect(rows.map((r: { actorId: string }) => r.actorId)).toEqual(["named"]);
  });

  it("re-keying keeps the DO id recorded by the old row when the new touch omits it", async () => {
    const registry = freshRegistry();
    await registry.updateConnections("counter", HEX, 1, HEX);
    await registry.touch("counter", "named", 1, HEX);
    expect(await registry.hasActor("counter", HEX)).toBe(true);
  });

  it("rejects invalid lookups instead of matching", async () => {
    const registry = freshRegistry();
    await registry.touch("counter", "room-1", 1);
    expect(await registry.hasActor("", "room-1")).toBe(false);
    expect(await registry.hasActor("counter", "")).toBe(false);
  });
});
