import { createOutbox, type OutboxEntry, type OutboxStorage } from "@actor-kit/worker/testing";
import { describe, expect, it } from "vitest";

// Fake in-memory storage for testing
function createFakeStorage(): OutboxStorage & { entries: OutboxEntry[]; failures: OutboxEntry[] } {
  const entries: OutboxEntry[] = [];
  const failures: OutboxEntry[] = [];
  return {
    entries,
    failures,
    insertEntries(newEntries: OutboxEntry[]) {
      entries.push(...newEntries);
    },
    getPending(): OutboxEntry[] {
      return entries.filter((e) => e.status === "pending");
    },
    markSent(id: string) {
      const entry = entries.find((e) => e.id === id);
      if (entry) entry.status = "sent";
    },
    incrementAttempts(id: string) {
      const entry = entries.find((e) => e.id === id);
      if (entry) entry.attempts += 1;
    },
    moveToFailures(id: string) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        const entry = entries[idx];
        if (entry !== undefined) {
          entries.splice(idx, 1);
          failures.push(entry);
        }
      }
    },
  };
}

describe("outbox", () => {
  describe("createOutbox", () => {
    it("collects emit() calls", () => {
      const outbox = createOutbox();
      outbox.emit({ queue: "EMAIL", body: { to: ["alice"] } });
      outbox.emit({ fetch: "https://api.example.com", body: {} });

      expect(outbox.getEmissions()).toHaveLength(2);
    });

    it("generates unique IDs for each entry", () => {
      const outbox = createOutbox();
      outbox.emit({ queue: "Q1", body: {} });
      outbox.emit({ queue: "Q2", body: {} });

      const entries = outbox.toEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]?.id).not.toBe(entries[1]?.id);
    });

    it("toEntries() produces OutboxEntry objects", () => {
      const outbox = createOutbox();
      outbox.emit({ queue: "EMAIL", body: { hello: true } });
      outbox.emit({ queue: "EFFECTS", body: { type: "RESERVE", itemId: "sword" } });

      const entries = outbox.toEntries();
      expect(entries).toHaveLength(2);

      expect(entries[0]?.status).toBe("pending");
      expect(entries[0]?.attempts).toBe(0);
      expect(entries[0]?.payload).toEqual({ queue: "EMAIL", body: { hello: true } });

      expect(entries[1]?.status).toBe("pending");
      expect(entries[1]?.payload).toEqual({ queue: "EFFECTS", body: { type: "RESERVE", itemId: "sword" } });
    });
  });

  describe("storage operations", () => {
    it("inserts entries into storage", () => {
      const storage = createFakeStorage();
      const outbox = createOutbox();
      outbox.emit({ queue: "Q1", body: {} });

      const entries = outbox.toEntries();
      storage.insertEntries(entries);

      expect(storage.entries).toHaveLength(1);
      expect(storage.getPending()).toHaveLength(1);
    });

    it("marks entries as sent", () => {
      const storage = createFakeStorage();
      const outbox = createOutbox();
      outbox.emit({ queue: "Q1", body: {} });

      const entries = outbox.toEntries();
      storage.insertEntries(entries);

      const entryId = entries[0]?.id;
      expect(entryId).toBeDefined();
      if (entryId) {
        storage.markSent(entryId);
        expect(storage.getPending()).toHaveLength(0);
      }
    });

    it("increments attempts on failure", () => {
      const storage = createFakeStorage();
      const outbox = createOutbox();
      outbox.emit({ queue: "Q1", body: {} });

      const entries = outbox.toEntries();
      storage.insertEntries(entries);

      const entryId = entries[0]?.id;
      expect(entryId).toBeDefined();
      if (entryId) {
        storage.incrementAttempts(entryId);
        expect(storage.entries[0]?.attempts).toBe(1);
      }
    });

    it("moves to failures after max attempts", () => {
      const storage = createFakeStorage();
      const outbox = createOutbox();
      outbox.emit({ queue: "Q1", body: {} });

      const entries = outbox.toEntries();
      storage.insertEntries(entries);

      const entryId = entries[0]?.id;
      expect(entryId).toBeDefined();
      if (entryId) {
        storage.moveToFailures(entryId);
        expect(storage.entries).toHaveLength(0);
        expect(storage.failures).toHaveLength(1);
      }
    });
  });
});
