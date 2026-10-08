/**
 * Bug: the Studio WebSocket route compared the Upgrade header case-sensitively, so a client
 * sending `Upgrade: WebSocket` (valid per RFC 6455 §4.2.1, the value is case-insensitive) got a 426.
 */
import { describe, expect, it } from "vitest";
import { actorKitStudio } from "../../packages/studio/src/middleware";

const ctx = { waitUntil: (_p: Promise<unknown>): void => {}, passThroughOnException: (): void => {} };

function counterEnv() {
  const fetched: Request[] = [];
  const stubFor = (methods: Record<string, unknown>) => ({
    idFromName: (name: string) => ({ toString: () => `name:${name}` }),
    idFromString: (hex: string) => ({ toString: () => hex }),
    get: () => methods,
  });
  const env = {
    STUDIO_REGISTRY: stubFor({ hasActor: async () => true }),
    COUNTER: stubFor({
      fetch: async (req: Request) => {
        fetched.push(req);
        return new Response("upgraded");
      },
    }),
  };
  return { env, fetched };
}

describe("studio WebSocket Upgrade header", () => {
  it.each(["WebSocket", "WEBSOCKET", "websocket"])("accepts Upgrade: %s", async (value) => {
    const { env, fetched } = counterEnv();
    const result = actorKitStudio(
      new Request("http://localhost/__studio/actors/counter/abc/ws", { headers: { Upgrade: value } }),
      env,
      ctx,
    );
    if (result === null) throw new Error("passed through");
    const res = await result;
    expect(res.status).toBe(200);
    expect(fetched).toHaveLength(1);
  });

  it.each(["h2c", "websocketx", ""])("still rejects Upgrade: %s with 426", async (value) => {
    const { env, fetched } = counterEnv();
    const result = actorKitStudio(
      new Request("http://localhost/__studio/actors/counter/abc/ws", { headers: { Upgrade: value } }),
      env,
      ctx,
    );
    if (result === null) throw new Error("passed through");
    const res = await result;
    expect(res.status).toBe(426);
    expect(res.headers.get("Upgrade")).toBe("websocket");
    expect(await res.json()).toEqual({ error: "Expected WebSocket" });
    expect(fetched).toEqual([]);
  });
});
