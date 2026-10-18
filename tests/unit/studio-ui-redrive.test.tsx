/**
 * @vitest-environment jsdom
 *
 * Outbox panel, ADR-015 D1: retry details (next try, last error) and the Redrive action on
 * dead letters (failed rows), which posts to the Studio actions route.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeWebSocket,
  fetchCalls,
  fetchInits,
  installFakes,
  renderAt,
  snapshotFrame,
  timelineEntry,
} from "./studio-ui-pages.helpers";

let actionResponse: () => Response | Promise<Response> = () => Response.json({ ok: true });

beforeEach(() => {
  actionResponse = () => Response.json({ ok: true });
  installFakes((url) => {
    if (url.pathname === "/__studio/api/actors") return Response.json({ actors: [] });
    if (url.pathname === "/__studio/api/actors/types") return Response.json({ types: [] });
    if (url.pathname === "/__studio/api/actors/counter/a1/actions") return actionResponse();
    throw new TypeError("Failed to fetch");
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openOutbox(outbox: unknown[]): Promise<FakeWebSocket> {
  renderAt("/actors/counter/a1");
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.latest();
  act(() => {
    ws.serverOpen();
    ws.serverSend(snapshotFrame({ count: 0 }, [timelineEntry(1, { count: 0 }, "init", {})]));
    ws.serverSend({ type: "studio.outbox", outbox });
  });
  fireEvent.click(screen.getByTestId("tab-outbox"));
  return ws;
}

function row(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, service: "NOTIFY", payload: "{}", status, attempts: 1, createdAt: 1, ...extra };
}

const actionCalls = () =>
  fetchCalls
    .map((url, i) => ({ url, init: fetchInits[i] }))
    .filter(({ url }) => url.pathname.endsWith("/actions"));

describe("Outbox panel: retries and dead letters", () => {
  it("shows the effect id, the last error and when a retrying row tries next", async () => {
    await openOutbox([row("12:0", "retrying", { nextAttemptAt: Date.now() + 5000, lastError: "timeout" })]);
    const text = screen.getByTestId("outbox-row").textContent ?? "";
    expect(text).toContain("12:0");
    expect(text).toContain("timeout");
    expect(screen.getByTestId("outbox-next-try").textContent).toMatch(/in \d+s/);
  });

  it("still renders rows from an actor that sends no retry fields", async () => {
    await openOutbox([row("e1", "done")]);
    expect(screen.getByTestId("outbox-row").getAttribute("data-status")).toBe("done");
    expect(screen.queryByTestId("outbox-next-try")).toBeNull();
  });

  it("offers Redrive only on failed rows", async () => {
    await openOutbox([row("3:0", "failed", { lastError: "boom" }), row("2:0", "done"), row("1:0", "retrying")]);
    expect(screen.getAllByRole("button", { name: /redrive/i })).toHaveLength(1);
  });

  it("Redrive posts the effect id to the actions route", async () => {
    await openOutbox([row("3:0", "failed", { lastError: "boom" })]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    const [call] = actionCalls();
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ action: "redrive", effectId: "3:0" });
  });

  it("shows the server's refusal (e.g. no mutate scope) instead of failing silently", async () => {
    actionResponse = () => Response.json({ error: "Studio actions need the mutate scope" }, { status: 403 });
    await openOutbox([row("3:0", "failed")]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    expect(await screen.findByText(/need the mutate scope/)).toBeTruthy();
  });
});

describe("Outbox panel: formatting", () => {
  // The offsets are taken from Date.now() here and the panel reads Date.now() again when it renders:
  // on a loaded machine the clock moved in between ("(in 4s)"). Freeze Date only; timers stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const nextTry = (offsetMs: number) => {
    cleanup();
    return openOutbox([row("1:0", "retrying", { nextAttemptAt: Date.now() + offsetMs })]).then(
      () => screen.getByTestId("outbox-next-try").textContent,
    );
  };

  it("shows seconds under a minute, minutes under an hour, then a clock time", async () => {
    expect(await nextTry(5_000)).toBe("(in 5s)");
    expect(await nextTry(59_000)).toBe("(in 59s)");
    expect(await nextTry(60_000)).toBe("(in 1m)");
    expect(await nextTry(150_000)).toBe("(in 3m)");
    expect(await nextTry(3_599_000)).toBe("(in 60m)");
    expect(await nextTry(7_200_000)).toMatch(/^\(\d{1,2}:\d{2}/);
  });

  it("an overdue retry is due in 0s, never a negative time", async () => {
    expect(await nextTry(-30_000)).toBe("(in 0s)");
  });

  it("shows no next try for a non-retrying row, even with a time", async () => {
    await openOutbox([row("1:0", "pending", { nextAttemptAt: Date.now() + 5000 })]);
    expect(screen.queryByTestId("outbox-next-try")).toBeNull();
  });

  it("colours each status, with grey for any other", async () => {
    await openOutbox([
      row("6:0", "done"),
      row("5:0", "failed"),
      row("4:0", "pending"),
      row("3:0", "running"),
      row("2:0", "retrying"),
      row("1:0", "parked"),
    ]);
    const statusCells = screen.getAllByTestId("outbox-row").map((r) => r.children[2]?.className ?? "");
    expect(statusCells).toEqual([
      "px-4 py-2 text-emerald-400",
      "px-4 py-2 text-red-400",
      "px-4 py-2 text-amber-400",
      "px-4 py-2 text-sky-400",
      "px-4 py-2 text-amber-300",
      "px-4 py-2 text-zinc-400",
    ]);
  });

  it("leaves the last error cell empty when there is none", async () => {
    await openOutbox([row("1:0", "done", { lastError: null })]);
    expect(screen.getByTestId("outbox-row").children[4]?.textContent).toBe("");
  });

  it("shows no error banner until an action fails", async () => {
    await openOutbox([row("3:0", "failed")]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Outbox panel: redrive in flight", () => {
  it("disables the button while the redrive is in flight, then enables it again", async () => {
    let release: (r: Response) => void = () => {};
    actionResponse = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    await openOutbox([row("3:0", "failed")]);
    const button = screen.getByRole("button", { name: /redrive 3:0/i });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    await act(async () => release(Response.json({ ok: true })));
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });

  it("clears an earlier error when the next redrive succeeds", async () => {
    actionResponse = () => Response.json({ error: "nope" }, { status: 409 });
    await openOutbox([row("3:0", "failed")]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    expect(await screen.findByText("nope")).toBeTruthy();
    actionResponse = () => Response.json({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("postAction errors", () => {
  it("sends JSON", async () => {
    await openOutbox([row("3:0", "failed")]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    await waitFor(() => expect(actionCalls()).toHaveLength(1));
    expect(new Headers(actionCalls()[0]?.init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("reports a network failure", async () => {
    actionResponse = () => {
      throw new TypeError("Failed to fetch");
    };
    await openOutbox([row("3:0", "failed")]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    expect(await screen.findByText("Network error: could not reach the Studio API")).toBeTruthy();
  });

  it("falls back to the status when the error body cannot be read", async () => {
    class Unreadable extends Response {
      override text(): Promise<string> {
        return Promise.reject(new Error("stream broken"));
      }
    }
    actionResponse = () => new Unreadable(null, { status: 502 });
    await openOutbox([row("3:0", "failed")]);
    fireEvent.click(screen.getByRole("button", { name: /redrive 3:0/i }));
    expect(await screen.findByText("HTTP 502")).toBeTruthy();
  });
});

describe("Outbox panel and postAction: boundaries", () => {
  it("an hour away is shown as a clock time, not minutes", async () => {
    await openOutbox([row("1:0", "retrying", { nextAttemptAt: Date.now() + 3_600_000 })]);
    expect(screen.getByTestId("outbox-next-try").textContent).not.toContain("m)");
  });

  it("a retrying row without a next time shows no next try", async () => {
    await openOutbox([row("1:0", "retrying", { nextAttemptAt: null })]);
    expect(screen.queryByTestId("outbox-next-try")).toBeNull();
  });

  it("postAction resolves on success and rejects with a classified StudioApiError otherwise", async () => {
    const { postAction, StudioApiError } = await import("../../packages/studio/ui/src/api");
    await expect(postAction("counter", "a1", { action: "redrive", effectId: "1:0" })).resolves.toBeUndefined();
    actionResponse = () => Response.json({ error: "nope" }, { status: 403 });
    await expect(postAction("counter", "a1", { action: "redrive", effectId: "1:0" })).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
    actionResponse = () => {
      throw new TypeError("offline");
    };
    const error = await postAction("counter", "a1", { action: "redrive", effectId: "1:0" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioApiError);
    expect(error).toMatchObject({ kind: "network", status: null });
  });
});
