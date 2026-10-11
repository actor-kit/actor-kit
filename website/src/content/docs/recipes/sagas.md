---
title: Sagas
description: Multi-step flows with compensation, built from states and scoped calls.
---

A saga is a flow of steps that each call another system, where a failure part-way must undo the steps
already done. Actor Kit has no `saga()` helper (ADR-018, ADR-019): the recipe is a state per step,
each making its call **scoped to itself**, and a `compensating` state that makes the undo calls in reverse.
The full, tested version is `examples/checkout-saga/checkout.ts`.

```typescript
const saga = setup({
  states: { idle: {}, reserving: {}, charging: {}, confirming: {}, compensating: {}, done: {} },
});
type SagaCtx = StateCallbackContext<NonNullable<typeof saga.states>, Checkout>;

/** The undo calls for the steps done so far, last step first; nothing done means nothing to undo. */
function compensate(s: Checkout, goto: SagaCtx["goto"]) {
  const undo: Undo[] = [];
  if (s.payment !== null) undo.push("refund");
  if (s.reservation !== null) undo.push("release");
  return undo.length === 0 ? goto("done", { ...s, outcome: "compensated" }) : goto("compensating", { ...s, undo });
}

export const Checkout = saga.actor("checkout", {
  // ...
  services: {
    charge: saga.service({
      result: z.object({ id: z.string() }),
      fn: async (order) => payments.charge(order),
      // Callbacks run at the state that owns the call and may goto: the step moves the saga on.
      onDone: (s: Checkout, { id }, _input, ctx) => ctx.goto("confirming", { ...s, payment: id }),
      onError: (s: Checkout, _error, _input, ctx) => compensate(s, ctx.goto),
      // The shopper cancelled while the charge ran, and it went through anyway: refund it too.
      onStale: (s: Checkout, { id }, _input, ctx) => {
        const late: Checkout = { ...s, payment: id, undo: [...s.undo, "refund"] };
        return ctx.phase[0] === "compensating" ? late : ctx.goto("compensating", late);
      },
    }),
    // reserve, confirm, release and refund follow the same pattern
  },
  states: {
    charging: charging.state({
      enter: (s: Checkout, _input, ctx) => {
        ctx.execute("charge", s.order, { scope: "state" });
        return null;
      },
      messages: {
        // Leaving charging aborts the charge (its AbortSignal); a late result goes to onStale.
        CANCEL: charging.message(z.object({}), (s: Checkout, _p, ctx) => compensate(s, ctx.goto)),
      },
    }),
    // Re-entered once per undo call: goto to the current state leaves and enters it again.
    compensating: saga.in("compensating").state({
      enter: (s: Checkout, _input, ctx) => {
        const [undo] = s.undo;
        if (undo !== undefined) ctx.execute(undo, undoInput(s, undo), { scope: "state" });
        return null;
      },
    }),
    // idle, reserving, confirming, done ...
  },
});
```

How it holds together:

- **One call per step, scoped to it.** A step's call cannot outlive its step: leaving the state cancels it,
  so a result never lands in the wrong step. A late result that matters (money moved) is handled in
  `onStale`; one that does not is journaled as `service.stale` and ignored.
- **Callbacks move the saga.** `onDone` goes to the next step, `onError` to `compensating`. Each runs at the
  state that owns its call, with `ctx.goto` typed by the kit.
- **Compensation in reverse, one call at a time.** The undo list lives in the shared state; each undo
  call's `onDone` drops its entry and re-enters `compensating` for the next, or ends the saga.
- **Every step is durable.** Calls go through the outbox (retries, dead letters, Studio's Outbox panel); an
  undo that fails for good leaves the order `stuck` for a person to look at.

Test it with `simulate()`: `pendingEffects()` shows the step's call, `resolve()` / `reject()` settle it,
and resolving a call cancelled by a state exit delivers the late result to `onStale`. `replayJournal()`
checks every flow (`tests/unit/checkout-saga.test.ts`).
