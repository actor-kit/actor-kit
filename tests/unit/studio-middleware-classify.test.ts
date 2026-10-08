/**
 * The audit event's route and actor (ADR-014) for every studio path, and the routing that
 * shares its path patterns: an actor route matches only the whole path.
 */
import { describe, expect, it } from "vitest";
import { createActorKitStudio, type StudioAuditEvent } from "../../packages/studio/src/middleware";

const ctx = { waitUntil: (_p: Promise<unknown>): void => {}, passThroughOnException: (): void => {} };

async function audit(path: string, method = "GET", env: Record<string, unknown> = {}): Promise<StudioAuditEvent> {
  const events: StudioAuditEvent[] = [];
  const studio = createActorKitStudio({ log: (e) => events.push(e) });
  await studio(new Request(`http://localhost/__studio${path}`, { method }), env, ctx);
  const event = events[0];
  if (event === undefined) throw new Error("no audit event");
  return event;
}

describe("audit route classification", () => {
  it.each([
    ["/api/actors", { route: "list" }],
    ["/api/actors/", { route: "list" }],
    ["/api/actors/types", { route: "types" }],
    ["/api/actors/counter/room-42/timeline", { route: "timeline", actorType: "counter", actorId: "room-42" }],
    ["/api/actors/counter/room-42/view", { route: "view", actorType: "counter", actorId: "room-42" }],
    ["/api/actors/counter/room-42/actions", { route: "action", actorType: "counter", actorId: "room-42" }],
    ["/api/actors/counter/room-42", { route: "inspect", actorType: "counter", actorId: "room-42" }],
    ["/actors/counter/room-42/ws", { route: "ws", actorType: "counter", actorId: "room-42" }],
    ["/api/actors/counter/room-42/view/extra", { route: "unknown" }],
    ["/api/actors/counter/room-42/timeline/extra", { route: "unknown" }],
    ["/api/actors/counter/room-42/actions/extra", { route: "unknown" }],
    ["/api/actors/counter/room-42/extra/more", { route: "unknown" }],
    ["/actors/counter/room-42/ws/extra", { route: "ui" }],
    ["/assets/api/actors/counter/room-42", { route: "ui" }],
    ["/assets/api/actors/counter/room-42/view", { route: "ui" }],
    ["/assets/api/actors/counter/room-42/timeline", { route: "ui" }],
    ["/assets/api/actors/counter/room-42/actions", { route: "ui" }],
    ["/x/actors/counter/room-42/ws", { route: "ui" }],
    ["/api", { route: "unknown" }],
    ["/apix", { route: "ui" }],
  ])("%s", async (path, expected) => {
    const event = await audit(path);
    expect({ route: event.route, actorType: event.actorType, actorId: event.actorId }).toEqual({
      actorType: undefined,
      actorId: undefined,
      ...expected,
    });
  });

  it("truncates a long actor type and id in the audit event", async () => {
    const event = await audit(`/api/actors/${"t".repeat(200)}/${"i".repeat(600)}`);
    expect(event.actorType).toBe("t".repeat(128));
    expect(event.actorId).toBe("i".repeat(512));
  });

  it("leaves out a segment that is not valid percent-encoding", async () => {
    const event = await audit("/api/actors/%ZZ/room-42");
    expect(event).toMatchObject({ route: "inspect", actorId: "room-42" });
    expect(event.actorType).toBeUndefined();
  });
});

describe("routing on the shared patterns", () => {
  const studio = createActorKitStudio({ log: () => {} });
  const get = async (path: string, env: Record<string, unknown> = {}) =>
    await studio(new Request(`http://localhost/__studio${path}`), env, ctx);

  it("a ws path with anything after it is the SPA, not a WebSocket", async () => {
    const res = await get("/actors/counter/room-42/ws/extra");
    expect(res?.headers.get("Content-Type")).toBe("text/html");
  });

  it("a ws path under another prefix is the SPA", async () => {
    const res = await get("/x/actors/counter/room-42/ws");
    expect(res?.headers.get("Content-Type")).toBe("text/html");
  });

  it("the exact ws path is not the SPA", async () => {
    const res = await get("/actors/counter/room-42/ws");
    expect(res?.headers.get("Content-Type")).not.toBe("text/html");
  });

  it("POST elsewhere says which method was refused", async () => {
    const res = await studio(new Request("http://localhost/__studio/api/actors", { method: "POST" }), {}, ctx);
    expect(await res?.json()).toEqual({ error: "Method POST not allowed" });
  });
});
