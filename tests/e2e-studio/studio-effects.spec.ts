/**
 * Studio Outbox and Links panels against real side effects (no fake data):
 * an AuctionRoom runs a slow NOTIFY_WINNER service and links to a Lobby
 * (tests/e2e-studio/effects-actors.ts). Studio stays open on the actor while
 * the effects happen, so every assertion is about live updates.
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
const RUN_ID = Date.now().toString(36);

/** Long enough to see "pending" in the browser, short enough to keep the suite fast. */
const SERVICE_DELAY_MS = 2_500;

function uniqueId(prefix: string): string {
  return `${prefix}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

type EffectsType = "lobby" | "auction-room";

async function spawn(
  request: APIRequestContext,
  type: EffectsType,
  actorId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${BASE_URL}/effects/spawn`, { data: { type, actorId, input } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function send(
  request: APIRequestContext,
  type: EffectsType,
  actorId: string,
  message: Record<string, unknown> & { type: string },
): Promise<void> {
  const res = await request.post(`${BASE_URL}/effects/send`, { data: { type, actorId, message } });
  expect(res.ok(), await res.text()).toBe(true);
  expect(await res.json()).toEqual({ ok: true });
}

/** Open the actor in Studio, wait for the live socket, then switch to a tab. */
async function openStudio(
  page: Page,
  type: EffectsType,
  actorId: string,
  tab: "state" | "outbox" | "links",
): Promise<void> {
  await page.goto(`${BASE_URL}/__studio/actors/${type}/${actorId}`);
  await expect(page.getByTestId("actor-title")).toContainText(actorId);
  await expect(page.getByTestId("status")).toHaveText("Live");
  await page.getByTestId(`tab-${tab}`).click();
}

test.describe("Studio — Outbox panel", () => {
  test("an execution shows as pending, then done, without a reload", async ({ page, request }) => {
    const roomId = uniqueId("room-ok");
    await spawn(request, "auction-room", roomId, { item: "lamp" });
    await openStudio(page, "auction-room", roomId, "outbox");
    await expect(page.getByTestId("outbox-panel")).toContainText("No executions.");

    await send(request, "auction-room", roomId, {
      type: "CLOSE",
      winner: "alice",
      delayMs: SERVICE_DELAY_MS,
      fail: false,
    });

    const rows = page.getByTestId("outbox-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("NOTIFY_WINNER");
    await expect(rows.first()).toHaveAttribute("data-status", "pending");
    await expect(page.getByTestId("tab-outbox")).toContainText("(1)");

    await expect(rows.first()).toHaveAttribute("data-status", "done", { timeout: SERVICE_DELAY_MS + 5_000 });

    // onDone fed back into state, and the timeline recorded it.
    await page.getByTestId("tab-state").click();
    await expect(page.getByTestId("state-panel")).toContainText("notified alice");
    await page.getByTestId("tab-timeline").click();
    await expect(page.getByTestId("timeline-panel")).toContainText("NOTIFY_WINNER completed");
  });

  test("a failing execution goes pending → failed and runs onError", async ({ page, request }) => {
    const roomId = uniqueId("room-fail");
    await spawn(request, "auction-room", roomId, { item: "vase" });
    await openStudio(page, "auction-room", roomId, "outbox");

    await send(request, "auction-room", roomId, {
      type: "CLOSE",
      winner: "bob",
      delayMs: SERVICE_DELAY_MS,
      fail: true,
    });

    const row = page.getByTestId("outbox-row").first();
    await expect(row).toHaveAttribute("data-status", "pending");
    await expect(row).toHaveAttribute("data-status", "failed", { timeout: SERVICE_DELAY_MS + 5_000 });

    await page.getByTestId("tab-state").click();
    await expect(page.getByTestId("state-panel")).toContainText("notify failed: mailbox full for bob");
    await page.getByTestId("tab-timeline").click();
    await expect(page.getByTestId("timeline-panel")).toContainText("NOTIFY_WINNER failed: mailbox full for bob");
  });

  test("done and failed executions are listed side by side", async ({ page, request }) => {
    const roomId = uniqueId("room-mixed");
    await spawn(request, "auction-room", roomId, { item: "clock" });
    await openStudio(page, "auction-room", roomId, "outbox");

    await send(request, "auction-room", roomId, { type: "CLOSE", winner: "carol", delayMs: 0, fail: false });
    await send(request, "auction-room", roomId, { type: "CLOSE", winner: "dave", delayMs: 0, fail: true });

    const rows = page.getByTestId("outbox-row");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("[data-testid='outbox-row'][data-status='done']")).toHaveCount(1);
    await expect(page.locator("[data-testid='outbox-row'][data-status='failed']")).toHaveCount(1);
  });
});

test.describe("Studio — Links panel", () => {
  test("linking shows the active link on the source and the subscriber on the target, live", async ({
    browser,
    request,
  }) => {
    const lobbyId = uniqueId("lobby");
    const roomId = uniqueId("room-link");
    await spawn(request, "lobby", lobbyId, { name: "Main Hall" });
    await spawn(request, "auction-room", roomId, { item: "rug" });

    const roomPage = await browser.newPage();
    const lobbyPage = await browser.newPage();
    await openStudio(roomPage, "auction-room", roomId, "links");
    await openStudio(lobbyPage, "lobby", lobbyId, "links");
    await expect(roomPage.getByTestId("links-panel")).toContainText("No active links.");
    await expect(lobbyPage.getByTestId("links-panel")).toContainText("No subscribers.");

    await send(request, "auction-room", roomId, { type: "LINK_LOBBY", lobbyId });

    const activeLink = roomPage.getByTestId("active-link-row");
    await expect(activeLink).toHaveCount(1);
    await expect(activeLink).toContainText("lobby");
    await expect(activeLink).toContainText(`LOBBY:${lobbyId}`);

    const subscriber = lobbyPage.getByTestId("link-subscriber-row");
    await expect(subscriber).toHaveCount(1);
    await expect(subscriber).toContainText("AUCTION_ROOM");
    // The subscriber is named by its actor ID, not an opaque Durable Object ID.
    await expect(subscriber).toContainText(roomId);

    // The link delivers the lobby's view into the room's state.
    await roomPage.getByTestId("tab-state").click();
    await expect(roomPage.getByTestId("state-panel")).toContainText("Main Hall");

    await roomPage.close();
    await lobbyPage.close();
  });

  test("a lobby rename flows over the link and bumps the link version", async ({ page, request }) => {
    const lobbyId = uniqueId("lobby-rename");
    const roomId = uniqueId("room-rename");
    await spawn(request, "lobby", lobbyId, { name: "East Wing" });
    await spawn(request, "auction-room", roomId, { item: "chair" });
    await send(request, "auction-room", roomId, { type: "LINK_LOBBY", lobbyId });

    await openStudio(page, "auction-room", roomId, "state");
    await expect(page.getByTestId("state-panel")).toContainText("East Wing");
    await page.getByTestId("tab-links").click();
    const version = page.getByTestId("active-link-row").getByTestId("active-link-version");
    const before = Number(await version.textContent());

    await send(request, "lobby", lobbyId, { type: "RENAME", name: "West Wing" });

    await expect.poll(async () => Number(await version.textContent())).toBeGreaterThan(before);
    await page.getByTestId("tab-state").click();
    await expect(page.getByTestId("state-panel")).toContainText("West Wing");
  });

  test("unlinking removes the link and the subscriber, live", async ({ browser, request }) => {
    const lobbyId = uniqueId("lobby-unlink");
    const roomId = uniqueId("room-unlink");
    await spawn(request, "lobby", lobbyId, { name: "Annex" });
    await spawn(request, "auction-room", roomId, { item: "desk" });
    await send(request, "auction-room", roomId, { type: "LINK_LOBBY", lobbyId });

    const roomPage = await browser.newPage();
    const lobbyPage = await browser.newPage();
    await openStudio(roomPage, "auction-room", roomId, "links");
    await openStudio(lobbyPage, "lobby", lobbyId, "links");
    await expect(roomPage.getByTestId("active-link-row")).toHaveCount(1);
    await expect(lobbyPage.getByTestId("link-subscriber-row")).toHaveCount(1);

    await send(request, "auction-room", roomId, { type: "UNLINK_LOBBY", lobbyId });

    await expect(roomPage.getByTestId("active-link-row")).toHaveCount(0);
    await expect(roomPage.getByTestId("links-panel")).toContainText("No active links.");
    await expect(lobbyPage.getByTestId("link-subscriber-row")).toHaveCount(0);
    await expect(lobbyPage.getByTestId("links-panel")).toContainText("No subscribers.");

    await roomPage.close();
    await lobbyPage.close();
  });
});
