/**
 * Studio on phone widths: no page ever scrolls sideways, and tabs, buttons and
 * form controls are thumb-sized (at least 40px tall). Every tab is filled with
 * real rows first (an outbox dead letter, a durable timer, a link, a client
 * connection, an expanded timeline entry), so wide tables are on the page.
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
const RUN_ID = Date.now().toString(36);
const MIN_TAP_PX = 40;

/** Smallest and most common phone widths (Galaxy Fold, iPhone SE). */
const VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 375, height: 667 },
  { width: 280, height: 653 },
];

const TABS: readonly string[] = ["state", "timeline", "connections", "outbox", "timers", "links"];

/** Long, unbroken ids like generated ones in the wild. */
function longId(prefix: string): string {
  return `${prefix}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}-0123456789abcdef0123456789`;
}

async function post(request: APIRequestContext, path: string, data: Record<string, unknown>): Promise<void> {
  const res = await request.post(`${BASE_URL}${path}`, { data });
  expect(res.ok(), await res.text()).toBe(true);
}

interface Seeded {
  roomId: string;
  ovenId: string;
  counterId: string;
}

/** An auction room with a failed (redrivable) execution and a lobby link, an oven with a timer, a counter. */
async function seed(request: APIRequestContext): Promise<Seeded> {
  const lobbyId = longId("m-lobby");
  const roomId = longId("m-room");
  const ovenId = longId("m-oven");
  const counterId = longId("m-counter");
  await post(request, "/effects/spawn", { type: "lobby", actorId: lobbyId, input: { name: "Main Hall" } });
  await post(request, "/effects/spawn", { type: "auction-room", actorId: roomId, input: { item: "lamp" } });
  await post(request, "/effects/send", {
    type: "auction-room",
    actorId: roomId,
    message: { type: "CLOSE", winner: "a-very-long-winner-name-without-spaces", delayMs: 0, fail: true },
  });
  await post(request, "/effects/send", {
    type: "auction-room",
    actorId: roomId,
    message: { type: "LINK_LOBBY", lobbyId },
  });
  await post(request, "/effects/spawn", { type: "oven", actorId: ovenId, input: {} });
  await post(request, "/effects/send", {
    type: "oven",
    actorId: ovenId,
    message: { type: "BAKE", dish: "sourdough", inMs: 600_000 },
  });
  await post(request, "/seed", { actorId: counterId, count: 2 });
  return { roomId, ovenId, counterId };
}

/** Hold a client connection open on the counter from another page, so Connections has a row. */
async function connectClient(page: Page, actorId: string, caller: string): Promise<void> {
  await page.goto(`${BASE_URL}/`);
  await page.evaluate(
    async ({ id, c, base }) => {
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/counter/${id}?caller=${encodeURIComponent(c)}`);
      Reflect.set(window, "__clientWs", ws);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
      });
    },
    { id: actorId, c: caller, base: BASE_URL },
  );
}

/** The page must not be wider than the viewport. */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where}: page scrolls sideways by ${scrollWidth - clientWidth}px`).toBeLessThanOrEqual(
    clientWidth,
  );
}

/**
 * Every visible button, tab, select and text input is at least MIN_TAP_PX tall. Inline expand/collapse
 * toggles inside a JSON tree are text in a code view, not controls, and are left out.
 */
async function expectTapTargets(page: Page, where: string): Promise<void> {
  const small = await page.locator("button:not([data-json-toggle]), select, input").evaluateAll(
    (els, min) =>
      els
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < min)
        .map(({ el, rect }) => `${el.getAttribute("data-testid") ?? el.textContent?.trim()} (${rect.height}px)`),
    MIN_TAP_PX,
  );
  expect(small, `${where}: controls shorter than ${MIN_TAP_PX}px`).toEqual([]);
}

async function expectPhoneFriendly(page: Page, where: string): Promise<void> {
  await expectNoSidewaysScroll(page, where);
  await expectTapTargets(page, where);
}

async function openActor(page: Page, type: string, actorId: string): Promise<void> {
  await page.goto(`${BASE_URL}/__studio/actors/${type}/${actorId}`);
  await expect(page.getByTestId("actor-title")).toContainText(actorId);
  await expect(page.getByTestId("status")).toHaveText("Live");
}

for (const viewport of VIEWPORTS) {
  test.describe(`Studio on a ${viewport.width}px phone`, () => {
    test.use({ viewport });

    test("dashboard does not scroll sideways and its controls are thumb-sized", async ({ page, request }) => {
      const { roomId } = await seed(request);
      await page.goto(`${BASE_URL}/__studio/`);
      await expect(page.getByTestId(`actor-link-${roomId}`)).toBeVisible({ timeout: 15_000 });
      await expectPhoneFriendly(page, "dashboard");

      // The actor table scrolls inside its own box; its last column is still reachable there.
      const table = page.getByTestId("actor-list");
      await expect(table.getByRole("columnheader", { name: "Connections" })).toBeAttached();
    });

    test("every tab of an auction room fits the screen", async ({ page, request }) => {
      const { roomId } = await seed(request);
      await openActor(page, "auction-room", roomId);
      await expect(page.getByTestId("tab-outbox")).toContainText("(1)");
      await page.getByTestId("tab-outbox").click();
      await expect(page.getByTestId("outbox-row").first()).toHaveAttribute("data-status", "failed", {
        timeout: 10_000,
      });
      await expect(page.getByTestId("tab-links")).toContainText("(1)");

      for (const tab of TABS) {
        await page.getByTestId(`tab-${tab}`).click();
        if (tab === "timeline") await page.locator("[data-testid^='timeline-entry-']").first().click();
        await expectPhoneFriendly(page, `auction-room ${tab} tab`);
      }
    });

    test("timers and connections with rows fit the screen", async ({ page, context, request }) => {
      const { ovenId, counterId } = await seed(request);

      await openActor(page, "oven", ovenId);
      await page.getByTestId("tab-timers").click();
      await expect(page.getByTestId("timer-row")).toHaveCount(1);
      await expectPhoneFriendly(page, "oven timers tab");

      const client = await context.newPage();
      await connectClient(client, counterId, "a-caller-with-a-really-long-identifier-0123456789");
      await openActor(page, "counter", counterId);
      await page.getByTestId("tab-connections").click();
      await expect(page.locator("[data-testid='connections-panel'] tbody tr")).toHaveCount(1, { timeout: 5_000 });
      await expectPhoneFriendly(page, "counter connections tab");
      await client.close();
    });
  });
}
