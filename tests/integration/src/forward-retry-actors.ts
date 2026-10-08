/**
 * Forward retries (tests/integration/forward-retry.test.ts).
 *
 * Courier forwards DELIVER messages through three links:
 * - `flaky` → FlakyInbox, a plain DO whose send() throws for the first `failTimes` calls per message
 *   id, then records the message (3 tries, 10 ms apart);
 * - `dead` → NotAnActor, whose stub has no send(): every try throws (2 tries);
 * - `nowhere` → a contract with no binding: the target cannot be resolved, so the forward is a dead
 *   letter at once.
 */

import { DurableObject } from "cloudflare:workers";
import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, link, message } from "@actor-kit/worker";
import { z } from "zod";

const Deliver = z.object({ type: z.literal("DELIVER"), id: z.string(), failTimes: z.number() });

export class FlakyInbox extends DurableObject {
  // Not async: workerd reports an error thrown by an async RPC method as an unhandled rejection
  // in the callee, even though the caller receives it. Throwing synchronously does not.
  send(caller: string, callerType: string, raw: unknown): Promise<{ ok: true }> {
    const msg = Deliver.parse(raw);
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS tries (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS received (id TEXT, caller TEXT, caller_type TEXT)");
    sql.exec("INSERT INTO tries (id, n) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1", msg.id);
    const tries = Number(sql.exec("SELECT n FROM tries WHERE id = ?", msg.id).one()["n"]);
    if (tries <= msg.failTimes) throw new Error(`inbox busy (try ${tries})`);
    sql.exec("INSERT INTO received (id, caller, caller_type) VALUES (?, ?, ?)", msg.id, caller, callerType);
    return Promise.resolve({ ok: true });
  }

  async received(): Promise<{ id: string; caller: string; callerType: string }[]> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS received (id TEXT, caller TEXT, caller_type TEXT)");
    return this.ctx.storage.sql
      .exec("SELECT id, caller, caller_type FROM received")
      .toArray()
      .map((r) => ({ id: String(r["id"]), caller: String(r["caller"]), callerType: String(r["caller_type"]) }));
  }
}

const contract = (name: string) => ({ name, def: {} });
const ignore = <S>(state: S) => state;
const fast = (attempts: number) => ({ attempts, backoff: { baseMs: 10, factor: 1, jitter: 0 } });

const CourierContract = defineActor("courier", {
  input: z.object({}),
  init: () => ({ sent: 0 }),
  roles: { any: () => true },
  links: {
    flaky: link(contract("flaky-inbox"), { onUpdate: ignore, retry: fast(3) }),
    dead: link(contract("not-an-actor"), { onUpdate: ignore, retry: fast(2) }),
    nowhere: link(contract("no-such-actor"), { onUpdate: ignore }),
    slow: link(contract("flaky-inbox"), { onUpdate: ignore, retry: { attempts: 2, backoff: { baseMs: 60_000 } } }),
  },
  messages: {
    SEND: message(
      z.object({ via: z.string(), to: z.string(), id: z.string(), failTimes: z.number() }),
      (state: { sent: number }, { via, to, id, failTimes }, ctx) => {
        ctx.forward(via, to, { type: "DELIVER", id, failTimes });
        return { sent: state.sent + 1 };
      },
    ),
  },
  views: { any: view.shared(schema({ sent: uint32 }), (s: { sent: number }) => ({ sent: s.sent })) },
  studio: { enabled: true },
});

export const Courier = createActorClass(CourierContract);
