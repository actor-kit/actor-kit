/**
 * @vitest-environment jsdom
 *
 * Phone widths (tests/e2e-studio/studio-mobile.spec.ts measures the real layout): every control
 * carries the phone tap-target class, and every wide table, the tab bar and timeline detail boxes
 * scroll inside their own container. jsdom has no layout, so this pins the classes that do it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPanel, LinksPanel } from "../../packages/studio/ui/src/components/actor-detail/inspect-panels";
import { TabBar } from "../../packages/studio/ui/src/components/actor-detail/tab-bar";
import { Pager } from "../../packages/studio/ui/src/components/dashboard/pager";
import { OutboxPanel } from "../../packages/studio/ui/src/components/outbox-panel";
import { SCROLL_X, TAP } from "../../packages/studio/ui/src/components/phone";
import { RestoreButton } from "../../packages/studio/ui/src/components/restore-button";
import { TimersPanel } from "../../packages/studio/ui/src/components/timers-panel";
import { FakeWebSocket, installFakes, renderAt, snapshotFrame, timelineEntry } from "./studio-ui-pages.helpers";

const noop = () => {};

function classesOf(el: Element | null): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/);
}

function expectTap(el: Element | null): void {
  expect(classesOf(el)).toContain(TAP);
}

/** The table's nearest wrapper scrolls sideways on its own. */
function expectScrollsInOwnBox(table: Element | null): void {
  expect(table?.tagName).toBe("TABLE");
  expect(classesOf(table?.parentElement ?? null)).toContain(SCROLL_X);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("phone rules", () => {
  it("are phone-only Tailwind classes, so desktop is untouched", () => {
    expect(TAP).toBe("max-sm:min-h-10");
    expect(SCROLL_X).toBe("overflow-x-auto");
  });
});

describe("tab bar on a phone", () => {
  it("scrolls in its own box, tabs keep their width and are thumb-sized", () => {
    render(
      <TabBar
        tabs={[
          { key: "state", label: "State" },
          { key: "outbox", label: "Outbox", count: 2 },
        ]}
        active="state"
        onSelect={noop}
      />,
    );
    expect(classesOf(screen.getByTestId("tab-bar"))).toContain(SCROLL_X);
    for (const id of ["tab-state", "tab-outbox"]) {
      const tab = screen.getByTestId(id);
      expectTap(tab);
      expect(classesOf(tab)).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    }
  });
});

describe("tables scroll inside their own box", () => {
  it("connections", () => {
    render(
      <ConnectionsPanel
        connections={[{ connectionId: "c1", caller: "u1", callerType: "user", connectedAt: 1, role: null }]}
      />,
    );
    expectScrollsInOwnBox(screen.getByRole("table"));
  });

  it("links: both the linked-to and subscriber tables", () => {
    render(
      <LinksPanel
        activeLinks={[{ targetType: "LOBBY", targetId: "l1", linkName: "lobby", version: 1 }]}
        linkSubscribers={[{ subscriberType: "DESK", subscriberId: "d1" }]}
      />,
    );
    const tables = screen.getAllByRole("table");
    expect(tables).toHaveLength(2);
    for (const table of tables) expectScrollsInOwnBox(table);
  });

  it("outbox, with a thumb-sized Redrive and a last-error column that does not shrink to one letter", () => {
    render(
      <OutboxPanel
        actorType="counter"
        actorId="a1"
        outbox={[
          { id: "1:0", service: "NOTIFY", payload: "{}", status: "failed", attempts: 1, createdAt: 1, lastError: "x" },
        ]}
      />,
    );
    expectScrollsInOwnBox(screen.getByRole("table"));
    expectTap(screen.getByRole("button", { name: "Redrive 1:0" }));
    expect(classesOf(screen.getByText("x"))).toEqual(expect.arrayContaining(["min-w-48", "break-all"]));
  });

  it("timers, with a thumb-sized Fire now", () => {
    render(
      <TimersPanel
        actorType="counter"
        actorId="a1"
        timers={[{ id: "t1", name: "done", key: "bake", payload: null, fireAt: Date.now() + 60_000, createdAt: 1 }]}
      />,
    );
    expectScrollsInOwnBox(screen.getByRole("table"));
    expectTap(screen.getByRole("button", { name: "Fire bake now" }));
  });
});

describe("buttons are thumb-sized", () => {
  it("pager", () => {
    render(<Pager offset={50} shown={2} hasMore={true} onPrevious={noop} onNext={noop} />);
    expectTap(screen.getByTestId("page-prev"));
    expectTap(screen.getByTestId("page-next"));
  });

  it("restore, confirm and cancel", () => {
    render(<RestoreButton actorType="counter" actorId="a1" seq={3} />);
    const restore = screen.getByRole("button", { name: "Restore to here" });
    expectTap(restore);
    fireEvent.click(restore);
    expectTap(screen.getByRole("button", { name: "Confirm restore" }));
    expectTap(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("dashboard on a phone", () => {
  beforeEach(() => {
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: ["counter"] });
      if (url.pathname === "/__studio/api/actors") {
        return Response.json({
          actors: [{ actorType: "counter", actorId: "c1", lastActiveAt: Date.now(), version: 1, connectionCount: 0 }],
        });
      }
      throw new TypeError("Failed to fetch");
    });
  });

  it("keeps a 16px gutter, wraps its forms, and makes every control thumb-sized", async () => {
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("actor-link-c1")).toBeTruthy());
    expect(classesOf(screen.getByRole("main"))).toEqual(expect.arrayContaining(["px-4", "sm:p-6"]));
    for (const id of ["type-filter", "search-input", "manual-type", "manual-id", "manual-connect"]) {
      expectTap(screen.getByTestId(id));
    }
    const search = screen.getByTestId("search-input");
    expect(classesOf(search)).toContain("max-sm:min-w-0");
    expect(classesOf(search.parentElement)).toContain("max-sm:flex-wrap");
    const manualId = screen.getByTestId("manual-id");
    expect(classesOf(manualId)).toEqual(expect.arrayContaining(["max-sm:min-w-0", "max-sm:basis-32"]));
    expect(classesOf(manualId.parentElement)).toContain("max-sm:flex-wrap");
  });

  it("scrolls the actor table in its own box and keeps ids readable", async () => {
    renderAt("/");
    const link = await waitFor(() => screen.getByTestId("actor-link-c1"));
    expect(classesOf(screen.getByTestId("actor-list"))).toContain(SCROLL_X);
    expect(classesOf(link.closest("td"))).toEqual(expect.arrayContaining(["min-w-48", "break-all"]));
  });
});

describe("timeline on a phone", () => {
  beforeEach(() => {
    installFakes((url) => {
      if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
      if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
      throw new TypeError("Failed to fetch");
    });
  });

  it("entries and the cause link are thumb-sized, and detail boxes scroll in their own box", async () => {
    renderAt("/actors/counter/a1");
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.latest();
    const caused = { ...timelineEntry(2, { count: 1 }), seq: 2, correlationId: "f", causationId: "counter/a1/1" };
    act(() => {
      ws.serverOpen();
      ws.serverSend(snapshotFrame({ count: 1 }, [caused, timelineEntry(1, { count: 0 }, "init", {})]));
    });
    fireEvent.click(screen.getByTestId("tab-timeline"));
    const entry = screen.getByTestId("timeline-entry-2");
    expectTap(entry);
    fireEvent.click(entry);
    expectTap(screen.getByTestId("entry-causation"));
    const box = screen.getByText("Cause data:").nextElementSibling;
    expect(classesOf(box)).toContain(SCROLL_X);
  });
});
