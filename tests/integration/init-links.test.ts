/**
 * init() can link to another actor (ctx.link in init): it receives the target's current view (with
 * its role), the link is persisted with the snapshot, and the target pushes later changes.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

async function bulletin(headline: string) {
  const id = unique("bulletin");
  const stub = env.BULLETIN.get(env.BULLETIN.idFromName(id));
  await stub.spawn({ actorId: id, caller: "svc", callerType: "service", input: { headline } });
  return { id, stub };
}

function kiosk() {
  const id = unique("kiosk");
  return { id, stub: env.KIOSK.get(env.KIOSK.idFromName(id)) };
}

const KioskState = z.object({ headline: z.string(), linkedRole: z.string() });
const LinkRow = z.object({ target_type: z.string(), target_id: z.string(), link_name: z.string() });

async function look(stub: DurableObjectStub) {
  return runInDurableObject(stub, async (_i, state) => ({
    state: KioskState.parse(JSON.parse(String(state.storage.sql.exec("SELECT state FROM snapshots").one()["state"]))),
    links: state.storage.sql
      .exec("SELECT target_type, target_id, link_name FROM active_links")
      .toArray()
      .map((row) => LinkRow.parse(row)),
  }));
}

async function spawnError(stub: DurableObjectStub, input: unknown): Promise<string> {
  try {
    await stub.spawn({ caller: "svc", callerType: "service", input });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected spawn to fail");
}

describe("ctx.link in init", () => {
  it("returns the target's view with its role and persists the link", async () => {
    const target = await bulletin("Morning edition");
    const { id, stub } = kiosk();
    await stub.spawn({
      actorId: id,
      caller: "svc",
      callerType: "service",
      input: { bulletinId: target.id, via: "bulletin" },
    });

    const { state, links } = await look(stub);
    expect(state).toEqual({ headline: "Morning edition", linkedRole: "reader" });
    expect(links).toEqual([{ target_type: "BULLETIN", target_id: target.id, link_name: "bulletin" }]);
  });

  it("subscribes to the target: later changes arrive through onUpdate", async () => {
    const target = await bulletin("Morning edition");
    const { id, stub } = kiosk();
    await stub.spawn({
      actorId: id,
      caller: "svc",
      callerType: "service",
      input: { bulletinId: target.id, via: "bulletin" },
    });

    await target.stub.send("svc", "service", { type: "EDIT", headline: "Evening edition" });
    await expect.poll(async () => (await look(stub)).state.headline).toBe("Evening edition");
  });

  it("refuses a link the actor does not declare, and a target nothing answers on", async () => {
    const target = await bulletin("Morning edition");
    expect(await spawnError(kiosk().stub, { bulletinId: target.id, via: "missing" })).toContain(
      'Link "missing" not declared in actor definition',
    );
    expect(await spawnError(kiosk().stub, { bulletinId: target.id, via: "ghost" })).toContain(
      'Link "ghost": target actor unreachable',
    );
  });
});
