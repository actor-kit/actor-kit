/**
 * @vitest-environment jsdom
 *
 * Studio shows where an actor's journal lives (ADR-019 D): the archived ranges in R2, the local range,
 * the object's storage size, and a warning near the per-object cap.
 */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes, journalSummary } from "../../packages/studio/ui/src/journal-storage";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

const GB = 1024 ** 3;
const journal = (overrides: object = {}) => ({
  local: { from: 121, to: 140, events: 20 },
  archived: [
    { from: 1, to: 60, bytes: 30_000 },
    { from: 61, to: 120, bytes: 16_080 },
  ],
  archivedBytes: 46_080,
  storageBytes: 1_258_291,
  capBytes: 10 * GB,
  nearCap: false,
  ...overrides,
});

describe("journal storage text", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(46_080)).toBe("45.0 KB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(10 * GB)).toBe("10.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
  });

  it("names the archived and local ranges and the storage", () => {
    expect(journalSummary(journal())).toEqual({
      archived: "seq 1–120 archived in R2 (2 segments, 45.0 KB)",
      local: "seq 121–140 local (20 events)",
      storage: "storage 1.2 MB of 10.0 GB (0%)",
      warning: null,
    });
    const three = [
      { from: 1, to: 4, bytes: 1 },
      { from: 5, to: 8, bytes: 1 },
      { from: 9, to: 12, bytes: 1 },
    ];
    expect(journalSummary(journal({ archived: three, archivedBytes: 3 })).archived).toBe(
      "seq 1–12 archived in R2 (3 segments, 3 B)",
    );
    expect(journalSummary(journal({ archived: [{ from: 1, to: 4, bytes: 10 }], archivedBytes: 10 })).archived).toBe(
      "seq 1–4 archived in R2 (1 segment, 10 B)",
    );
    expect(journalSummary(journal({ archived: [], archivedBytes: 0, local: null }))).toMatchObject({
      archived: null,
      local: "no local events",
    });
  });

  it("warns near the cap", () => {
    expect(journalSummary(journal({ storageBytes: 9 * GB, nearCap: true })).warning).toBe(
      "Storage is at 90% of the 10.0 GB per-object limit. Prune or archive the journal (journal: { keep, archive }).",
    );
  });
});

describe("actor header", () => {
  beforeEach(() => {
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
      throw new TypeError("Failed to fetch");
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function open(extra: object) {
    renderAt("/actors/tally/t1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.latest();
    act(() => {
      ws.serverOpen();
      ws.serverSend({ ...snapshotFrame({ n: 1 }, [timelineEntry(1, { n: 1 }, "init", {})]), ...extra });
    });
  }

  it("shows the journal's ranges and storage, and the warning near the cap", async () => {
    await open({ journal: journal({ storageBytes: 9 * GB, nearCap: true }) });
    expect(screen.getByTestId("journal-storage").textContent).toBe(
      "Journal: seq 1–120 archived in R2 (2 segments, 45.0 KB) · seq 121–140 local (20 events) · storage 9.0 GB of 10.0 GB (90%)",
    );
    expect(screen.getByTestId("journal-storage-warning").getAttribute("role")).toBe("alert");
  });

  it("shows only what there is: no archive, no warning far from the cap", async () => {
    await open({ journal: journal({ archived: [], archivedBytes: 0 }) });
    expect(screen.getByTestId("journal-storage").textContent).toBe(
      "Journal: seq 121–140 local (20 events) · storage 1.2 MB of 10.0 GB (0%)",
    );
    expect(screen.queryByTestId("journal-storage-warning")).toBeNull();
  });

  it("shows nothing for an actor without a journal", async () => {
    await open({});
    expect(screen.queryByTestId("journal-storage")).toBeNull();
  });
});
