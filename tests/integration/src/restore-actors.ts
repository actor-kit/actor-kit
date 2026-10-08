/**
 * Ledger: an actor for the restore tests (ADR-015 D3). ADD changes state, BUY executes PAY (which
 * counts its calls, so a test can tell it never ran again), SLOW executes STUCK (which waits a
 * minute between two tries, so its row stays pending), LATER schedules a timer.
 * LedgerNoJournal has `journal: false`; LedgerNoStudio has Studio off.
 */

import { schema, uint32, view } from "@actor-kit/core";
import { createActorClass, defineActor, message, timer } from "@actor-kit/worker";
import { z } from "zod";

export type LedgerState = { total: number; paid: string[]; rings: string[] };

/** PAY calls per item, across instances (one isolate in the test pool). */
export const payCalls = new Map<string, number>();

const LedgerContract = defineActor("ledger", {
  input: z.object({}),
  init: (): LedgerState => ({ total: 0, paid: [], rings: [] }),
  roles: { clerk: () => true },
  messages: {
    ADD: message(z.object({ n: z.number() }), (s: LedgerState, { n }) => ({ ...s, total: s.total + n })),
    BUY: message(z.object({ item: z.string() }), (s: LedgerState, { item }, ctx) => {
      ctx.execute("PAY", { item });
      return s;
    }),
    SLOW: message(z.object({}), (s: LedgerState, _p, ctx) => {
      ctx.execute("STUCK", {});
      return s;
    }),
    LATER: message(z.object({ inMs: z.number(), key: z.string() }), (s: LedgerState, { inMs, key }, ctx) => {
      ctx.schedule("ring", { in: inMs, key, payload: { key } });
      return s;
    }),
  },
  timers: {
    ring: timer(z.object({ key: z.string() }), (s: LedgerState, { key }) => ({ ...s, rings: [...s.rings, key] })),
  },
  services: {
    PAY: {
      retry: { attempts: 1 },
      fn: async (input: unknown) => {
        const { item } = z.object({ item: z.string() }).parse(input);
        payCalls.set(item, (payCalls.get(item) ?? 0) + 1);
        return { receipt: `r-${item}` };
      },
      onDone: (s: LedgerState, result: unknown) => ({
        ...s,
        paid: [...s.paid, z.object({ receipt: z.string() }).parse(result).receipt],
      }),
    },
    STUCK: {
      retry: { attempts: 2, backoff: { baseMs: 60_000, jitter: 0 } },
      fn: async (): Promise<never> => {
        throw new Error("stuck");
      },
    },
  },
  views: { clerk: view.shared(schema({ total: uint32 }), (s: LedgerState) => ({ total: s.total })) },
  studio: { enabled: true },
  journal: { checkpointEvery: 4 },
});

export const Ledger = createActorClass(LedgerContract);
export const LedgerNoJournal = createActorClass(
  defineActor("ledger-no-journal", { ...LedgerContract.def, journal: false }),
);
export const LedgerNoStudio = createActorClass(
  defineActor("ledger-no-studio", { ...LedgerContract.def, studio: { enabled: false } }),
);
export { LedgerContract };
