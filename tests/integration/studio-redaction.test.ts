/**
 * Server-side redaction and agent caller hashing (ADR-014) against a real Durable Object.
 *
 * StudioRedacted keeps children's names in state, payloads, service input/output and views.
 * No Studio entry point (RPC, studio WebSocket, middleware) may return one.
 */

import { createExecutionContext, env } from "cloudflare:test";
import { createActorKitStudio } from "@actor-kit/studio";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const NAME = "Juneau";
const KID = "kid-juneau-ipad";

function stubFor(id: string): DurableObjectStub {
  return env.STUDIO_REDACTED.get(env.STUDIO_REDACTED.idFromName(id));
}

async function rpc(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<unknown> {
  const fn: unknown = Reflect.get(stub, method);
  if (typeof fn !== "function") throw new Error(`${method} missing`);
  return await Reflect.apply(fn, stub, args);
}

async function socket(stub: DurableObjectStub, callerId: string, headers: Record<string, string> = {}) {
  const response = await stub.fetch("http://localhost/ws", {
    headers: {
      Upgrade: "websocket",
      "X-Actor-Kit-Caller-Id": callerId,
      "X-Actor-Kit-Caller-Type": callerId === "__studio" ? "service" : "user",
      ...headers,
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (ws === null) throw new Error("no WebSocket");
  const frames: string[] = [];
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") frames.push(e.data);
  });
  ws.accept();
  return { ws, frames };
}

async function until(check: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A spawned actor with a kid joined (message + lifecycle), a service round-trip done, and a kid socket open. */
async function populated(id: string) {
  const stub = stubFor(id);
  await rpc(stub, "spawn", { actorId: id, caller: "host", callerType: "service", input: {} });
  const kid = await socket(stub, KID);
  await rpc(stub, "send", KID, "user", { type: "JOIN", name: NAME });
  await rpc(stub, "send", "host", "service", { type: "SAVE_NAME", name: NAME });
  // Let the outbox drain the SAVE service (onDone records a timeline entry).
  await until(() => false, 300).catch(() => {});
  return { stub, kid };
}

const Inspect = z.object({
  state: z.unknown(),
  connections: z.array(z.object({ caller: z.string() })),
  outbox: z.array(z.object({ payload: z.string() })),
});
const Timeline = z.object({ entries: z.array(z.object({ causeType: z.string(), causeData: z.string() })) });

describe("studio redaction (RPC)", () => {
  it("__inspect redacts state and outbox payloads; people see raw callers", async () => {
    const { stub } = await populated(`redact-inspect-${Date.now()}`);
    const raw = await rpc(stub, "__inspect");
    expect(JSON.stringify(raw)).not.toContain(NAME);
    const body = Inspect.parse(raw);
    expect(body.state).toMatchObject({ players: [{ id: "[redacted]", name: "[redacted]" }], round: 1 });
    expect(body.outbox.length).toBeGreaterThan(0);
    expect(body.connections.map((c) => c.caller)).toContain(KID);
  });

  it("__inspect as agent hashes callers everywhere they appear", async () => {
    const { stub } = await populated(`redact-inspect-agent-${Date.now()}`);
    const body = Inspect.parse(await rpc(stub, "__inspect", { viewer: "agent" }));
    expect(body.connections.map((c) => c.caller)).toEqual([expect.stringMatching(/^caller:[0-9a-f]{12}$/)]);
    // Ids inside state are application data: the actor's redact patterns govern them, not caller hashing.
    expect(JSON.stringify(body)).not.toContain(KID);
  });

  it("__getTimeline never returns a redacted value, in any cause", async () => {
    const { stub } = await populated(`redact-timeline-${Date.now()}`);
    const raw = await rpc(stub, "__getTimeline", { limit: 50 });
    expect(JSON.stringify(raw)).not.toContain(NAME);
    const causes = Timeline.parse(raw).entries.map((e) => e.causeType);
    expect(causes).toEqual(expect.arrayContaining(["init", "message", "service.onDone"]));
  });

  it("__getTimeline as agent hashes callers in causes", async () => {
    const { stub } = await populated(`redact-timeline-agent-${Date.now()}`);
    const raw = await rpc(stub, "__getTimeline", { limit: 50, viewer: "agent" });
    expect(JSON.stringify(raw)).not.toContain(KID);
    const message = Timeline.parse(raw).entries.find((e) => e.causeType === "message");
    expect(JSON.parse(message?.causeData ?? "{}")).toMatchObject({ caller: expect.stringMatching(/^caller:/) });
  });

  it("__getTimeline rejects an unknown viewer", async () => {
    const { stub } = await populated(`redact-timeline-bad-${Date.now()}`);
    await expect(rpc(stub, "__getTimeline", { viewer: "root" })).rejects.toThrow(/Invalid timeline options/);
  });

  it("__getView redacts shared and perCaller views", async () => {
    const { stub } = await populated(`redact-view-${Date.now()}`);
    expect(await rpc(stub, "__getView", { role: "host" })).toMatchObject({ data: { names: "[redacted]" } });
    const perCaller = await rpc(stub, "__getView", { role: "kid", caller: KID });
    expect(perCaller).toMatchObject({ caller: KID, callerRole: "kid", data: { name: "[redacted]" } });
    const asAgent = await rpc(stub, "__getView", { role: "kid", caller: KID, viewer: "agent" });
    expect(JSON.stringify(asAgent)).not.toContain(KID);
  });

  it("__getView reports a perCaller view without a caller as an error, not a throw", async () => {
    const { stub } = await populated(`redact-view-err-${Date.now()}`);
    expect(await rpc(stub, "__getView", { role: "kid" })).toMatchObject({
      error: expect.stringContaining("perCaller"),
    });
  });

  it("the app itself still gets real values (redaction is Studio-only)", async () => {
    const { kid } = await populated(`redact-app-${Date.now()}`);
    await until(() => kid.frames.some((f) => f.includes(NAME)));
  });
});

describe("studio redaction (studio WebSocket)", () => {
  it("snapshot, live timeline pushes and view replies are redacted", async () => {
    const id = `redact-ws-${Date.now()}`;
    const { stub } = await populated(id);
    const studio = await socket(stub, "__studio", { "X-Actor-Kit-Studio-Viewer": "human" });
    await until(() => studio.frames.some((f) => f.includes("studio.snapshot")));
    await rpc(stub, "send", "kid-sis", "user", { type: "JOIN", name: NAME });
    await until(() => studio.frames.some((f) => f.includes("studio.timeline")));
    studio.ws.send(JSON.stringify({ type: "studio.requestView", role: "host" }));
    await until(() => studio.frames.some((f) => f.includes("studio.view")));
    expect(studio.frames.join("\n")).not.toContain(NAME);
    expect(studio.frames.join("\n")).toContain(KID);
  });

  it("an agent studio socket gets hashed callers in snapshot, pushes and connection notices", async () => {
    const id = `redact-ws-agent-${Date.now()}`;
    const { stub } = await populated(id);
    const studio = await socket(stub, "__studio", { "X-Actor-Kit-Studio-Viewer": "agent" });
    await until(() => studio.frames.some((f) => f.includes("studio.snapshot")));
    const other = await socket(stub, "kid-sis");
    await until(() => studio.frames.some((f) => f.includes("studio.connection")));
    await rpc(stub, "send", "kid-sis", "user", { type: "JOIN", name: "Sis" });
    await until(() => studio.frames.some((f) => f.includes("studio.timeline")));
    const all = studio.frames.join("\n");
    expect(all).not.toContain(KID);
    expect(all).not.toContain('"kid-sis"');
    expect(all).toContain("caller:");
    other.ws.close();
  });
});

describe("studio redaction through the middleware", () => {
  const ACCESS = { STUDIO_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", STUDIO_ACCESS_AUD: "aud" };

  async function agentStudio() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "RS256" }] });
    const token = await new SignJWT({ sub: "", common_name: "sre-agent.access" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("aud")
      .setExpirationTime("5m")
      .sign(privateKey);
    return { token, studio: createActorKitStudio({ access: { keysFor: () => jwks }, log: () => {} }) };
  }

  it("an agent's timeline over HTTP has neither names nor raw callers", async () => {
    const id = `redact-mw-${Date.now()}`;
    await populated(id);
    await new Promise((r) => setTimeout(r, 100)); // registry touch is fire-and-forget
    const { token, studio } = await agentStudio();
    const req = new Request(`https://studio.example.com/__studio/api/actors/studio-redacted/${id}/timeline`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await studio(req, { ...env, ...ACCESS }, createExecutionContext());
    expect(res?.status).toBe(200);
    const text = (await res?.text()) ?? "";
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(KID);
  });

  it("refuses agents with 503 when STUDIO_CALLER_HASH_KEY is unset", async () => {
    const id = `redact-mw-nokey-${Date.now()}`;
    await populated(id);
    const { token, studio } = await agentStudio();
    const req = new Request(`https://studio.example.com/__studio/api/actors/studio-redacted/${id}`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const res = await studio(req, { ...env, ...ACCESS, STUDIO_CALLER_HASH_KEY: "" }, createExecutionContext());
    expect(res?.status).toBe(503);
  });
});
