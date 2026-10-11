/**
 * The saga recipe (ADR-019 B), on examples/checkout-saga: reserve → charge → confirm, each a state whose
 * call is scoped to it; a failure or a cancel compensates in reverse (refund, then release); a charge
 * that answers after a cancel is refunded through onStale. Every flow replays from its journal.
 */
import { replayJournal, simulate, testActor } from "@actor-kit/test";
import { phasedState } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";
import { CheckoutContract } from "../../examples/checkout-saga/checkout";

async function checkout() {
  const sim = simulate({ contracts: [CheckoutContract], now: 0 });
  const c = await sim.spawn(CheckoutContract, "o1", {});
  expect(c.send("ann", { type: "CHECKOUT", sku: "tee", cents: 2500 })).toEqual({ ok: true });
  return { sim, c };
}

/** The one pending call: its service, and settle it. */
function pending(sim: Awaited<ReturnType<typeof checkout>>["sim"]) {
  const [call, ...rest] = sim.pendingEffects();
  expect(rest).toEqual([]);
  if (call === undefined) throw new Error("no pending call");
  return call;
}

const shared = (state: unknown) => phasedState(state).shared;

describe("checkout saga (simulate)", () => {
  it("reserve → charge → confirm, one scoped call per step", async () => {
    const { sim, c } = await checkout();
    expect(pending(sim)).toMatchObject({ service: "reserve", input: { sku: "tee", cents: 2500 } });
    sim.resolve(pending(sim), { id: "res-1" });
    expect(pending(sim)).toMatchObject({ service: "charge" });
    sim.resolve(pending(sim), { id: "pay-1" });
    expect(pending(sim)).toMatchObject({ service: "confirm", input: { reservation: "res-1", payment: "pay-1" } });
    sim.resolve(pending(sim), { ok: true });
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "confirmed", undo: [] } });
    expect(c.view("ann")).toEqual({ step: "done", outcome: "confirmed" });
    await replayJournal(CheckoutContract, c.journal);
  });

  it("a failed reserve has nothing to undo", async () => {
    const { sim, c } = await checkout();
    sim.reject(pending(sim), "out of stock");
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "compensated" } });
    expect(sim.pendingEffects()).toEqual([]);
  });

  it("a failed charge releases the reservation", async () => {
    const { sim, c } = await checkout();
    sim.resolve(pending(sim), { id: "res-1" });
    sim.reject(pending(sim), "card declined");
    expect(pending(sim)).toMatchObject({ service: "release", input: { reservation: "res-1" } });
    sim.resolve(pending(sim), { ok: true });
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "compensated", reservation: null } });
    await replayJournal(CheckoutContract, c.journal);
  });

  it("a failed confirm undoes in reverse: refund, then release", async () => {
    const { sim, c } = await checkout();
    sim.resolve(pending(sim), { id: "res-1" });
    sim.resolve(pending(sim), { id: "pay-1" });
    sim.reject(pending(sim), "warehouse down");
    expect(shared(c.state)).toMatchObject({ undo: ["refund", "release"] });
    expect(pending(sim)).toMatchObject({ service: "refund", input: { payment: "pay-1" } });
    sim.resolve(pending(sim), { ok: true });
    expect(pending(sim)).toMatchObject({ service: "release", input: { reservation: "res-1" } });
    sim.resolve(pending(sim), { ok: true });
    expect(c.state).toMatchObject({
      phase: ["done"],
      shared: { outcome: "compensated", payment: null, reservation: null, undo: [] },
    });
    await replayJournal(CheckoutContract, c.journal);
  });

  it("a cancel while charging aborts the charge; a late charge is refunded after the release", async () => {
    const { sim, c } = await checkout();
    sim.resolve(pending(sim), { id: "res-1" });
    const charge = pending(sim);
    expect(c.send("ann", { type: "CANCEL" })).toEqual({ ok: true });
    expect(pending(sim)).toMatchObject({ service: "release" });
    sim.resolve(charge, { id: "pay-late" }); // the charge went through anyway: onStale
    expect(shared(c.state)).toMatchObject({ payment: "pay-late", undo: ["release", "refund"] });
    sim.resolve(pending(sim), { ok: true });
    expect(pending(sim)).toMatchObject({ service: "refund", input: { payment: "pay-late" } });
    sim.resolve(pending(sim), { ok: true });
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "compensated", payment: null } });
    expect(c.journal.events.map((e) => e.causeType)).toContain("service.stale");
    await replayJournal(CheckoutContract, c.journal);
  });

  it("a late charge after compensation finished starts compensating again", async () => {
    const { sim, c } = await checkout();
    sim.resolve(pending(sim), { id: "res-1" });
    const charge = pending(sim);
    c.send("ann", { type: "CANCEL" });
    sim.resolve(pending(sim), { ok: true }); // release: compensated
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "compensated" } });
    sim.resolve(charge, { id: "pay-late" });
    expect(c.state).toMatchObject({ phase: ["compensating"], shared: { outcome: "open", undo: ["refund"] } });
    sim.resolve(pending(sim), { ok: true });
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "compensated", payment: null } });
    await replayJournal(CheckoutContract, c.journal);
  });

  it("an undo that fails for good leaves the order stuck, for a person to look at", async () => {
    const { sim, c } = await checkout();
    sim.resolve(pending(sim), { id: "res-1" });
    sim.reject(pending(sim), "declined");
    sim.reject(pending(sim), "inventory down");
    expect(c.state).toMatchObject({ phase: ["done"], shared: { outcome: "stuck" } });
  });
});

describe("checkout saga (testActor)", () => {
  it("each step's call is scoped to its state: leaving charging cancels the charge as stale", async () => {
    const t = testActor(CheckoutContract);
    const started = await t.send(t.init({}), "ann", { type: "CHECKOUT", sku: "tee", cents: 100 });
    expect(started.executions).toEqual([{ service: "reserve", input: { sku: "tee", cents: 100 } }]);
    expect(started.state).toMatchObject({ phase: ["reserving"], stateTimers: [["0:0"]] });
    // Charging, with the reservation made and the charge (effect 0:0) in flight.
    const charging: Parameters<typeof t.send>[0] = {
      shared: { order: { sku: "tee", cents: 100 }, reservation: "res-1", payment: null, undo: [], outcome: "open" },
      phase: ["charging"],
      locals: [null],
      stateTimers: [["0:0"]],
    };
    const cancelled = await t.send(charging, "ann", { type: "CANCEL" });
    expect(cancelled.cancels).toEqual(["0:0"]);
    expect(cancelled.executions).toEqual([{ service: "release", input: { reservation: "res-1" } }]);
    expect(cancelled.state).toMatchObject({ phase: ["compensating"], shared: { undo: ["release"] } });
  });
});
