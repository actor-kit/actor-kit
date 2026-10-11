// Checkout saga (ADR-019 B): reserve → charge → confirm, each step a state that makes its call scoped
// to itself. A step that fails, or a shopper who cancels, goes to `compensating`, which undoes the steps
// already done in reverse (refund, then release), one call at a time. A charge that answers after the
// shopper cancelled reaches `onStale`, which adds its refund to the undo list. Browser-safe contract.

import { schema, string, view } from "@actor-kit/core";
import { type PhasedStateOf, type StateCallbackContext, setup } from "@actor-kit/worker/testing";
import { z } from "zod";

/** The undo calls, by the step they undo. */
export type Undo = "release" | "refund";

export type Checkout = {
  order: { sku: string; cents: number } | null;
  reservation: string | null;
  payment: string | null;
  /** Undo calls still to make, in order (the reverse of the steps done). */
  undo: Undo[];
  outcome: "open" | "confirmed" | "compensated" | "stuck";
};

const Order = z.object({ sku: z.string(), cents: z.number().int().positive() });
const Receipt = z.object({ id: z.string() });

const saga = setup({
  states: {
    idle: {},
    reserving: {},
    charging: {},
    confirming: {},
    compensating: {},
    done: {},
  },
});

export type CheckoutState = PhasedStateOf<typeof saga, Checkout>;

/** What a service callback of the saga can do besides returning the state: goto (and read the path). */
type SagaCtx = StateCallbackContext<NonNullable<typeof saga.states>, Checkout>;

const idle = saga.in("idle");
const charging = saga.in("charging");

/**
 * Compensate: the undo calls for the steps done so far, last step first (refund, then release). With
 * nothing done there is nothing to undo, and the saga ends.
 */
function compensate(s: Checkout, goto: SagaCtx["goto"]) {
  const undo: Undo[] = [];
  if (s.payment !== null) undo.push("refund");
  if (s.reservation !== null) undo.push("release");
  return undo.length === 0
    ? goto("done", { ...s, outcome: "compensated" })
    : goto("compensating", { ...s, undo });
}

/** After an undo call: the next one (re-enter compensating), or the end once the list is empty. */
function undone(s: Checkout, ctx: SagaCtx) {
  const [, ...undo] = s.undo;
  const after = { ...s, undo };
  return undo.length === 0 ? ctx.goto("done", { ...after, outcome: "compensated" }) : ctx.goto("compensating", after);
}

/** The undo call `compensating` makes for each entry of the list. */
const undoInput = (s: Checkout, undo: Undo) => (undo === "refund" ? { payment: s.payment } : { reservation: s.reservation });

export const CheckoutContract = saga.actor("checkout", {
  input: z.object({}),
  init: (): Checkout => ({ order: null, reservation: null, payment: null, undo: [], outcome: "open" }),
  roles: { shopper: () => true },
  initial: "idle",
  services: {
    reserve: saga.service({
      result: Receipt,
      fn: async (input) => ({ id: `res-${Order.parse(input).sku}` }),
      onDone: (s: Checkout, { id }, _input, ctx) => ctx.goto("charging", { ...s, reservation: id }),
      // Nothing was done yet: nothing to undo.
      onError: (s: Checkout, _error, _input, ctx) => compensate(s, ctx.goto),
    }),
    charge: saga.service({
      result: Receipt,
      fn: async (input) => ({ id: `pay-${Order.parse(input).cents}` }),
      onDone: (s: Checkout, { id }, _input, ctx) => ctx.goto("confirming", { ...s, payment: id }),
      onError: (s: Checkout, _error, _input, ctx) => compensate(s, ctx.goto),
      // The shopper cancelled while the charge ran, and it went through anyway: refund it too, last.
      onStale: (s: Checkout, { id }, _input, ctx) => {
        const late: Checkout = { ...s, payment: id, undo: [...s.undo, "refund"] };
        return ctx.phase[0] === "compensating" ? late : ctx.goto("compensating", { ...late, outcome: "open" });
      },
    }),
    confirm: saga.service({
      fn: async () => ({ ok: true }),
      onDone: (s: Checkout, _result, _input, ctx) => ctx.goto("done", { ...s, outcome: "confirmed" }),
      onError: (s: Checkout, _error, _input, ctx) => compensate(s, ctx.goto),
    }),
    release: saga.service({
      fn: async () => ({ ok: true }),
      onDone: (s: Checkout, _result, _input, ctx) => undone({ ...s, reservation: null }, ctx),
      onError: (s: Checkout, _error, _input, ctx) => ctx.goto("done", { ...s, outcome: "stuck" }),
    }),
    refund: saga.service({
      fn: async () => ({ ok: true }),
      onDone: (s: Checkout, _result, _input, ctx) => undone({ ...s, payment: null }, ctx),
      onError: (s: Checkout, _error, _input, ctx) => ctx.goto("done", { ...s, outcome: "stuck" }),
    }),
  },
  states: {
    idle: idle.state({
      messages: {
        CHECKOUT: idle.message(Order, (s: Checkout, order, ctx) => ctx.goto("reserving", { ...s, order })),
      },
    }),
    reserving: saga.in("reserving").state({
      enter: (s: Checkout, _input, ctx) => {
        ctx.execute("reserve", s.order, { scope: "state" });
        return null;
      },
    }),
    charging: charging.state({
      enter: (s: Checkout, _input, ctx) => {
        ctx.execute("charge", s.order, { scope: "state" });
        return null;
      },
      messages: {
        // Leaving charging aborts the charge; if it still answers, onStale adds its refund.
        CANCEL: charging.message(z.object({}), (s: Checkout, _p, ctx) => compensate(s, ctx.goto)),
      },
    }),
    confirming: saga.in("confirming").state({
      enter: (s: Checkout, _input, ctx) => {
        ctx.execute("confirm", { reservation: s.reservation, payment: s.payment }, { scope: "state" });
        return null;
      },
    }),
    // Re-entered for each undo call: goto to the current state exits and enters it again.
    compensating: saga.in("compensating").state({
      enter: (s: Checkout, _input, ctx) => {
        const [undo] = s.undo;
        if (undo !== undefined) ctx.execute(undo, undoInput(s, undo), { scope: "state" });
        return null;
      },
    }),
    done: saga.in("done").state({}),
  },
  views: {
    shopper: view.shared(schema({ step: string, outcome: string }), (st: CheckoutState) => ({
      step: st.phase.join("."),
      outcome: st.shared.outcome,
    })),
  },
});

export type CheckoutContract = typeof CheckoutContract;
