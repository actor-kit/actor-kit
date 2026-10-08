import { createOutbox } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("outbox effect ids (ADR-015 D1)", () => {
  it("numbers a transition's effects in declaration order across executions and forwards", () => {
    const outbox = createOutbox();
    outbox.execute("EMAIL", { a: 1 });
    outbox.forward("COUNTER", "c-1", { type: "INCREMENT" });
    outbox.link("ROOM", "r-1"); // links are not effects
    outbox.execute("SMS", { b: 2 });

    expect(outbox.toExecutionEntries(7).map((e) => [e.id, e.seq, e.index, e.service])).toEqual([
      ["7:0", 7, 0, "EMAIL"],
      ["7:2", 7, 2, "SMS"],
    ]);
    expect(outbox.toForwardEntries(7).map((e) => [e.id, e.seq, e.index, e.linkName])).toEqual([
      ["7:1", 7, 1, "COUNTER"],
    ]);
  });

  it("is deterministic: the same transition at the same seq gets the same ids", () => {
    const run = () => {
      const outbox = createOutbox();
      outbox.execute("EMAIL", {});
      outbox.execute("EMAIL", {});
      return outbox.toExecutionEntries(3).map((e) => e.id);
    };
    expect(run()).toEqual(["3:0", "3:1"]);
    expect(run()).toEqual(run());
  });

  it("entries start pending with no attempts", () => {
    const outbox = createOutbox();
    outbox.execute("EMAIL", { to: "x" });
    outbox.forward("COUNTER", "c-1", { type: "PING" });
    expect(outbox.toExecutionEntries(1)[0]).toMatchObject({ status: "pending", attempts: 0, input: { to: "x" } });
    expect(outbox.toForwardEntries(1)[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      targetId: "c-1",
      message: { type: "PING" },
    });
  });
});
