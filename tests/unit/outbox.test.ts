import { createOutbox } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

describe("outbox", () => {
  describe("createOutbox", () => {
    it("collects execute() calls", () => {
      const outbox = createOutbox();
      outbox.execute("EMAIL", { to: ["alice"] });
      outbox.execute("ANALYTICS", { event: "click" });

      expect(outbox.getExecutions()).toHaveLength(2);
    });

    it("generates unique IDs for each entry", () => {
      const outbox = createOutbox();
      outbox.execute("SVC1", {});
      outbox.execute("SVC2", {});

      const entries = outbox.toExecutionEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]?.id).not.toBe(entries[1]?.id);
    });

    it("toExecutionEntries() produces ExecutionEntry objects", () => {
      const outbox = createOutbox();
      outbox.execute("EMAIL", { to: "alice" });
      outbox.execute("NOTIFY", { type: "RESERVE" });

      const entries = outbox.toExecutionEntries();
      expect(entries).toHaveLength(2);

      expect(entries[0]?.status).toBe("pending");
      expect(entries[0]?.attempts).toBe(0);
      expect(entries[0]?.service).toBe("EMAIL");
      expect(entries[0]?.payload).toEqual({ to: "alice" });

      expect(entries[1]?.status).toBe("pending");
      expect(entries[1]?.service).toBe("NOTIFY");
    });

    it("getExecutions() returns all collected executions", () => {
      const outbox = createOutbox();
      outbox.execute("SVC_A", { x: 1 });
      outbox.execute("SVC_B", { y: 2 });

      const executions = outbox.getExecutions();
      expect(executions).toHaveLength(2);
      expect(executions[0]).toEqual({ service: "SVC_A", payload: { x: 1 } });
      expect(executions[1]).toEqual({ service: "SVC_B", payload: { y: 2 } });
    });

    it("empty outbox returns empty arrays", () => {
      const outbox = createOutbox();
      expect(outbox.getExecutions()).toHaveLength(0);
      expect(outbox.toExecutionEntries()).toHaveLength(0);
    });
  });
});
