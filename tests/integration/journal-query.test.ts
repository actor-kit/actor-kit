/**
 * ADR-019 F against real Durable Objects: the `__journal` RPC returns journal entries filtered by
 * seq range, cause type, emitted event name and correlation id, with emitted events (marked when
 * published) and trace ids, redacted per ADR-014; the Studio route `/api/actors/:type/:id/journal`
 * parses the query and forwards it with the viewer. A lookup never creates an actor.
 */
import { createExecutionContext, env } from "cloudflare:test";
import { actorKitStudio } from "@actor-kit/studio";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Entry = z.object({
  id: z.string(),
  seq: z.number(),
  causeType: z.string(),
  cause: z.record(z.string(), z.unknown()),
  emitted: z.array(z.object({ name: z.string(), payload: z.unknown(), published: z.boolean() })),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  createdAt: z.number(),
  codeVersion: z.number(),
  checksum: z.string(),
});
const Page = z.object({ entries: z.array(Entry), hasMore: z.boolean() });

async function rpc(stub: DurableObjectStub, method: string, ...args: unknown[]): Promise<unknown> {
  const fn: unknown = Reflect.get(stub, method);
  if (typeof fn !== "function") throw new Error(`${method} missing`);
  return await Reflect.apply(fn, stub, args);
}

async function lot(id: string): Promise<DurableObjectStub> {
  const stub = env.LOT.get(env.LOT.idFromName(id));
  await rpc(stub, "spawn", { actorId: id, caller: "host", callerType: "service", input: {} });
  await rpc(stub, "send", "ann", "user", { type: "PLACE", n: 1 });
  await rpc(stub, "send", "bo", "user", { type: "PLACE", n: 2 });
  return stub;
}

const journal = async (stub: DurableObjectStub, opts?: unknown) => Page.parse(await rpc(stub, "__journal", opts));
const seqs = (page: z.infer<typeof Page>) => page.entries.map((e) => e.seq);

describe("__journal (integration)", () => {
  it("returns entries newest first with emitted events, published flags and trace ids", async () => {
    const id = `jq-lot-${Date.now()}`;
    const stub = await lot(id);
    const page = await journal(stub);

    expect(seqs(page)).toEqual([3, 2, 1]);
    expect(page.hasMore).toBe(false);
    const [newest] = page.entries;
    expect(newest).toMatchObject({
      id: `lot/${id}/3`,
      causeType: "message",
      cause: { messageType: "PLACE", caller: "bo", role: "any", payload: { n: 2 } },
      emitted: [
        { name: "Noted", payload: {}, published: false },
        { name: "Placed", payload: { n: 2 }, published: true },
      ],
      correlationId: `lot/${id}/3`,
      causationId: null,
    });
  });

  it("filters by emitted event, cause type and seq range, and reads oldest first", async () => {
    const stub = await lot(`jq-filter-${Date.now()}`);
    expect(seqs(await journal(stub, { event: "Placed" }))).toEqual([3, 2]);
    expect(seqs(await journal(stub, { causeType: "init" }))).toEqual([1]);
    expect(seqs(await journal(stub, { from: 2, to: 2 }))).toEqual([2]);
    const asc = await journal(stub, { order: "asc", limit: 2 });
    expect(seqs(asc)).toEqual([1, 2]);
    expect(asc.hasMore).toBe(true);
    expect(seqs(await journal(stub, { order: "asc", from: 3 }))).toEqual([3]);
  });

  it("filters by correlation id", async () => {
    const id = `jq-corr-${Date.now()}`;
    const stub = await lot(id);
    expect(seqs(await journal(stub, { correlationId: `lot/${id}/2` }))).toEqual([2]);
  });

  it("redacts values and hashes callers for agents (ADR-014)", async () => {
    const id = `jq-redact-${Date.now()}`;
    const stub = env.STUDIO_REDACTED.get(env.STUDIO_REDACTED.idFromName(id));
    await rpc(stub, "spawn", { actorId: id, caller: "host", callerType: "service", input: {} });
    await rpc(stub, "send", "kid-juneau-ipad", "user", { type: "JOIN", name: "Juneau" });

    const human = await journal(stub, { causeType: "message" });
    const agent = await journal(stub, { causeType: "message", viewer: "agent" });
    expect(JSON.stringify(human)).not.toContain("Juneau");
    expect(human.entries[0]?.cause["caller"]).toBe("kid-juneau-ipad");
    expect(JSON.stringify(agent)).not.toContain("Juneau");
    expect(JSON.stringify(agent)).not.toContain("kid-juneau-ipad");
    expect(agent.entries[0]?.cause["caller"]).toMatch(/^caller:[0-9a-f]{12}$/);
  });

  it("returns an empty page for an actor that was never spawned, without creating it", async () => {
    const id = `jq-none-${Date.now()}`;
    const stub = env.LOT.get(env.LOT.idFromName(id));
    expect(await journal(stub, {})).toEqual({ entries: [], hasMore: false });
    expect(await rpc(stub, "__inspect")).toMatchObject({ initialized: false, actorId: null });
  });

  it("rejects invalid options", async () => {
    const stub = await lot(`jq-invalid-${Date.now()}`);
    await expect(rpc(stub, "__journal", { causeType: "nope" })).rejects.toThrow("Invalid journal query");
  });

  it("is refused when Studio is off for the actor", async () => {
    const id = `jq-off-${Date.now()}`;
    const stub = env.STUDIO_OFF.get(env.STUDIO_OFF.idFromName(id));
    await rpc(stub, "spawn", { actorId: id, caller: "u", callerType: "user", input: {} });
    await expect(rpc(stub, "__journal", {})).rejects.toThrow("Studio is not enabled");
  });
});

describe("Studio journal route (integration)", () => {
  async function studioFetch(path: string): Promise<Response> {
    const result = actorKitStudio(new Request(`http://localhost${path}`), { ...env }, createExecutionContext());
    if (result === null) throw new Error(`middleware did not handle ${path}`);
    return await result;
  }

  it("forwards the parsed query to __journal", async () => {
    const id = `jq-route-${Date.now()}`;
    await lot(id);
    await new Promise((r) => setTimeout(r, 100)); // registry touches are fire-and-forget

    const res = await studioFetch(`/__studio/api/actors/lot/${id}/journal?event=Placed&order=asc&limit=1`);
    expect(res.status).toBe(200);
    const page = Page.parse(await res.json());
    expect(seqs(page)).toEqual([2]);
    expect(page.hasMore).toBe(true);
  });

  it("rejects a bad query parameter with 400 before contacting the actor", async () => {
    const res = await studioFetch(`/__studio/api/actors/lot/jq-route-bad/journal?causeType=nope`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining("causeType") });
  });

  it("is a 404 for an unknown actor", async () => {
    const res = await studioFetch(`/__studio/api/actors/lot/jq-route-missing-${Date.now()}/journal`);
    expect(res.status).toBe(404);
  });
});
