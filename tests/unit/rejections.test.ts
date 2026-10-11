/** ADR-018 F: rejections are recorded outside the journal (rows, counts per code, a log line). */
import { xxh64 } from "@actor-kit/core";
import {
  ACTOR_KIT_MIGRATIONS,
  payloadHash,
  readRejections,
  recordRejection,
  rejectionCounts,
  rejectionEvent,
} from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { createNodeSql } from "./helpers/node-sql";

function store() {
  const sql = createNodeSql();
  for (const migration of ACTOR_KIT_MIGRATIONS) sql.exec(migration.sql);
  return sql;
}

const base = {
  code: "guard_failed",
  messageName: "BID",
  caller: "ann",
  callerType: "user",
  role: "bidder",
  payload: { amount: 5 },
  at: 1000,
} as const;

describe("rejections", () => {
  it("records a row per refusal, newest first, with the payload's hash (never the payload)", () => {
    const sql = store();
    recordRejection(sql, base);
    recordRejection(sql, { ...base, code: "no_role", role: null, caller: "x", at: 2000 });
    expect(readRejections(sql, 10)).toEqual([
      {
        code: "no_role",
        messageName: "BID",
        caller: "x",
        callerType: "user",
        role: null,
        payloadHash: payloadHash({ amount: 5 }),
        at: 2000,
      },
      {
        code: "guard_failed",
        messageName: "BID",
        caller: "ann",
        callerType: "user",
        role: "bidder",
        payloadHash: payloadHash({ amount: 5 }),
        at: 1000,
      },
    ]);
    expect(readRejections(sql, 1)).toHaveLength(1);
    expect(payloadHash({ amount: 5 })).toBe(xxh64('{"amount":5}'));
    expect(payloadHash(undefined)).toBe(xxh64("null"));
  });

  it("keeps the newest rows, but counts every refusal by code", () => {
    const sql = store();
    for (let i = 0; i < 5; i++) recordRejection(sql, { ...base, at: i }, 3);
    recordRejection(sql, { ...base, code: "invalid_payload", at: 9 }, 3);
    expect(readRejections(sql, 10).map((r) => r.at)).toEqual([9, 4, 3]);
    expect(rejectionCounts(sql)).toEqual({ total: 6, byCode: { guard_failed: 5, invalid_payload: 1 } });
  });

  it("an actor that refused nothing counts zero", () => {
    expect(rejectionCounts(store())).toEqual({ total: 0, byCode: {} });
  });

  it("logs one structured line: stable fields first, no caller id, no payload", () => {
    expect(rejectionEvent("auction", "a1", base)).toStrictEqual({
      event: "actor_kit.message.rejected",
      actorType: "auction",
      actorId: "a1",
      code: "guard_failed",
      message: "BID",
      callerType: "user",
      role: "bidder",
      payloadHash: payloadHash({ amount: 5 }),
    });
  });
});
