/**
 * Cashier: service handles, result schemas and delivery modes (ADR-018 G), in the setup-first shape.
 *
 * - CHARGE parses its result (extra fields dropped) and records an audit fact.
 * - SLOW waits until its signal is aborted (ctx.cancel), then throws.
 * - BAD_RESULT returns a result its schema refuses: a Defect, 1 try.
 * - ONCE is at-most-once; LOOSE is at-least-once with 1 try (an eviction is its last attempt).
 * - BROKEN_DONE's onDone throws: the row ends as a dead letter carrying the reason.
 */

import { createActorClass, setup } from "@actor-kit/worker";
import { z } from "zod";

export type CashierState = { ids: string[]; log: string[] };

const cashier = setup({ events: { Charged: z.object({ effectId: z.string() }) } });

const log = (s: CashierState, line: string): CashierState => ({ ...s, log: [...s.log, line] });

const Cashier = cashier.actor("cashier", {
  input: z.object({}),
  init: (): CashierState => ({ ids: [], log: [] }),
  roles: { any: () => true },
  messages: {
    BUY: cashier.message(
      z.object({ service: z.enum(["CHARGE", "SLOW", "BAD_RESULT", "ONCE", "LOOSE", "BROKEN_DONE"]) }),
      (s: CashierState, { service }, ctx) => ({ ...s, ids: [...s.ids, ctx.execute(service, { cents: 5 })] }),
    ),
    CANCEL: cashier.message(z.object({ id: z.string() }), (s: CashierState, { id }, ctx) => {
      ctx.cancel(id);
      return s;
    }),
  },
  services: {
    CHARGE: cashier.service({
      result: z.object({ receipt: z.string() }),
      fn: async (_input, _env, effect) => {
        effect.record("gateway", "test");
        return { receipt: "r-1", secret: "dropped" };
      },
      onDone: (s: CashierState, result, _input, ctx) => {
        ctx.emit("Charged", { effectId: ctx.effectId });
        return log(s, `done ${ctx.effectId} ${JSON.stringify(result)}`);
      },
    }),
    SLOW: cashier.service({
      timeoutMs: 60_000,
      fn: (_input, _env, effect) =>
        new Promise((_resolve, reject) => {
          effect.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      onDone: (s: CashierState) => log(s, "slow done"),
      onError: (s: CashierState) => log(s, "slow error"),
    }),
    BAD_RESULT: cashier.service({
      result: z.object({ n: z.number() }),
      retry: { attempts: 1 },
      fn: async () => ({ n: "x" }),
      onError: (s: CashierState, error) => log(s, `bad ${error._tag} ${error._tag === "Defect" ? error.message : ""}`),
    }),
    ONCE: cashier.service({
      delivery: "at-most-once",
      fn: async () => "ok",
      onDone: (s: CashierState) => log(s, "once done"),
      onError: (s: CashierState, error) => log(s, `once error ${error._tag}`),
    }),
    BROKEN_DONE: cashier.service({
      fn: async () => "ok",
      onDone: (): CashierState => {
        throw new Error("onDone is broken");
      },
    }),
    LOOSE: cashier.service({
      retry: { attempts: 1 },
      fn: async () => "ok",
      onDone: (s: CashierState) => log(s, "loose done"),
      onError: (s: CashierState, error) => log(s, `loose error ${error._tag}`),
    }),
  },
  views: { any: { fn: (s: CashierState) => ({ log: s.log.length }) } },
  studio: { enabled: true },
});

export const CashierActor = createActorClass(Cashier);
