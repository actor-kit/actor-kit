/**
 * The version chain on a real Durable Object (ADR-015 D5): a stored state from an older version
 * is stepped (state steps) or rebuilt by replaying the journal under the new handlers (rebuild:
 * "replay", older payloads upcast), journaled as a migrate event with a checkpoint, after which
 * the journal replays from that bump.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { replayJournal } from "@actor-kit/test";
import { createActorClass, defineActor } from "@actor-kit/worker";
import { readJournal } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RosterActor, RosterContract } from "./src/versions-actors";

let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}`;

describe("rebuild by replay", () => {
  it("rebuilds an older stored state from the journal, upcasting older payloads", async () => {
    const name = unique("roster");
    const stub = env.ROSTER.get(env.ROSTER.idFromName(name));
    await stub.spawn({ actorId: name, caller: "svc", callerType: "service", input: {} });
    await stub.send("u", "user", { type: "JOIN", name: "ann", avatar: "a.png" });
    await stub.send("u", "user", { type: "JOIN", name: "bob", avatar: "b.png" });

    const result = await runInDurableObject(stub, async (_i, state) => {
      const sql = state.storage.sql;
      // As version 1 wrote it: names only, JOIN payloads without avatars, version 1 everywhere.
      sql.exec("UPDATE events SET code_version = 1");
      sql.exec(`UPDATE events SET payload = '{"name":"ann"}' WHERE seq = 2`);
      sql.exec(`UPDATE events SET payload = '{"name":"bob"}' WHERE seq = 3`);
      sql.exec(`UPDATE snapshots SET version = 1, state = '{"players":["ann","bob"]}'`);
      const fresh = new RosterActor(state, env);
      const view = await fresh.getSnapshot("u", "user");
      const afterRebuild = {
        view: view.snapshot,
        journal: readJournal(sql),
        snapshot: sql.exec("SELECT state, version FROM snapshots").one(),
      };
      // A new message on the rebuilt actor (this instance: the stub's old one still holds v1 in memory).
      await fresh.send("u", "user", { type: "JOIN", name: "cy", avatar: null });
      return { ...afterRebuild, later: readJournal(sql) };
    });

    expect(result.view).toEqual({ players: 2 });
    expect(JSON.parse(String(result.snapshot["state"]))).toEqual({
      players: [
        { name: "ann", avatar: null },
        { name: "bob", avatar: null },
      ],
    });
    expect(result.snapshot["version"]).toBe(2);
    const bump = result.journal.events.at(-1);
    expect(bump).toMatchObject({
      seq: 4,
      causeType: "migrate",
      payload: { fromVersion: 1, toVersion: 2 },
      codeVersion: 2,
    });
    expect(result.journal.checkpoints.map((c) => c.seq)).toEqual([4]);

    // The journal now replays from the bump; older events are history.
    const replayed = await replayJournal(RosterContract, result.later);
    expect(replayed.replayed).toBe(1);
    expect(replayed.state).toEqual({
      players: [
        { name: "ann", avatar: null },
        { name: "bob", avatar: null },
        { name: "cy", avatar: null },
      ],
    });
  });
});

describe("no compatibility shim", () => {
  it("a contract that still uses version or migrate is refused, pointing at versions", () => {
    const base = { input: z.object({}), init: () => ({ n: 0 }), roles: { any: () => true }, views: {} };
    expect(() => createActorClass(defineActor("old-version", { ...base, version: 2 }))).toThrow(
      /"version" and "migrate" are replaced by versions/,
    );
    expect(() => createActorClass(defineActor("old-migrate", { ...base, migrate: (p: unknown) => p }))).toThrow(
      /replaced by versions/,
    );
  });
});
