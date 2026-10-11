/**
 * ADR-019 E against real bindings: a real Queue batch (createMessageBatch) through the test Worker's
 * consumer into real D1, with duplicates and reordering; real Lot actors publishing through the real
 * `lot-events` queue into the read model; and rebuild() replaying the actors' journals through
 * `__journal` into a fresh read model with the same positions.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { actorJournalSource } from "@actor-kit/projection";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ensureLotReadModel, lotProjection } from "./src/lot-projection";
import worker from "./src/worker";

const LogRow = z.object({ actor_id: z.string(), position: z.number(), seq: z.number(), n: z.number() });

async function log(actorId: string) {
  const { results } = await env.PROJECTION_DB.prepare(
    "SELECT actor_id, position, seq, n FROM lot_log WHERE actor_id = ? ORDER BY position",
  )
    .bind(actorId)
    .all();
  return results.map((r) => LogRow.parse(r));
}

async function total(actorId: string): Promise<number | null> {
  const row = await env.PROJECTION_DB.prepare("SELECT total FROM lot_totals WHERE actor_id = ?").bind(actorId).first();
  return row === null ? null : z.object({ total: z.number() }).parse(row).total;
}

function placed(actorId: string, position: number, n: number) {
  const seq = position + 1;
  return {
    actorType: "lot",
    actorId,
    seq,
    index: 1,
    name: "Placed",
    payload: { n },
    at: 1,
    causationId: `lot/${actorId}/${seq}`,
    correlationId: `lot/${actorId}/${seq}`,
    idempotencyKey: `lot/${actorId}/${seq}:1`,
    position,
  };
}

async function deliver(bodies: unknown[]) {
  const batch = createMessageBatch(
    "lot-events",
    bodies.map((body, i) => ({ id: `m${i}-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue(batch, env);
  return await getQueueResult(batch, ctx);
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return read();
}

describe("projection (integration)", () => {
  it("applies a real batch once and in order, acking duplicates and buffering a gap", async () => {
    const id = `proj-batch-${Date.now()}`;
    const first = await deliver([placed(id, 2, 20), placed(id, 1, 10), placed(id, 1, 10), placed(id, 4, 40)]);
    expect(first.explicitAcks).toHaveLength(4);
    expect(first.retryMessages).toEqual([]);
    expect((await log(id)).map((r) => [r.position, r.n])).toEqual([
      [1, 10],
      [2, 20],
    ]);
    expect(await lotProjection.buffered(env)).toContainEqual({
      actorType: "lot",
      actorId: id,
      applied: 2,
      next: 4,
      count: 1,
    });

    const second = await deliver([placed(id, 3, 30), placed(id, 2, 20)]);
    expect(second.explicitAcks).toHaveLength(2);
    expect((await log(id)).map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(await total(id)).toBe(100);
  });

  it("retries a body that is not a published event", async () => {
    const result = await deliver([{ nope: true }]);
    expect(result.retryMessages).toHaveLength(1);
  });

  it("keeps a read model of real actors publishing through the real queue", async () => {
    const id = `proj-live-${Date.now()}`;
    const stub = env.LOT.get(env.LOT.idFromName(id));
    await stub.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    for (const n of [1, 2, 3]) await stub.send("u", "user", { type: "PLACE", n });
    const rows = await until(
      () => log(id),
      (r) => r.length === 3,
    );
    expect(rows.map((r) => [r.position, r.seq, r.n])).toEqual([
      [1, 2, 1],
      [2, 3, 2],
      [3, 4, 3],
    ]);
    expect(await total(id)).toBe(6);
  });

  it("rebuilds from the actors' journals with the positions they assigned, across a restore", async () => {
    const id = `proj-rebuild-${Date.now()}`;
    const stub = env.LOT.get(env.LOT.idFromName(id));
    await stub.spawn({ actorId: id, caller: "u", callerType: "user", input: {} });
    await stub.send("u", "user", { type: "PLACE", n: 1 });
    await stub.send("u", "user", { type: "PLACE", n: 2 });
    expect(await stub.__restore({ toSeq: 2 })).toEqual({ ok: true });
    await stub.send("u", "user", { type: "PLACE", n: 4 });
    const live = await until(
      () => log(id),
      (r) => r.length === 3,
    );

    await ensureLotReadModel(env.PROJECTION_DB);
    const result = await lotProjection.rebuild(env, {
      source: actorJournalSource((type) => (type === "lot" ? env.LOT : undefined)),
      actors: [{ actorType: "lot", actorId: id }],
    });
    expect(result).toEqual({ actors: 1, events: 3 });
    expect(await log(id)).toEqual(live);
    expect(await total(id)).toBe(7);

    // Live consumption continues from the rebuilt cursor: a redelivered event is a duplicate.
    await deliver([placed(id, 3, 4), placed(id, 4, 8)]);
    expect((await log(id)).map((r) => r.position)).toEqual([1, 2, 3, 4]);
  });
});
