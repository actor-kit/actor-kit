/**
 * Studio Timers panel against a real durable timer (ADR-015 D2): an Oven schedules `done` under
 * the key `bake`. Studio stays open on the actor, so the row appears and disappears live, the
 * payload's secret is redacted, and "Fire now" runs the timer exactly as the alarm would.
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
const RUN_ID = Date.now().toString(36);

function uniqueId(prefix: string): string {
  return `${prefix}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

async function post(request: APIRequestContext, path: string, data: unknown): Promise<void> {
  const res = await request.post(`${BASE_URL}${path}`, { data });
  expect(res.ok(), await res.text()).toBe(true);
}

async function spawnOven(request: APIRequestContext, actorId: string): Promise<void> {
  await post(request, "/effects/spawn", { type: "oven", actorId, input: {} });
}

async function bake(request: APIRequestContext, actorId: string, dish: string, inMs: number): Promise<void> {
  await post(request, "/effects/send", { type: "oven", actorId, message: { type: "BAKE", dish, inMs } });
}

async function openTimers(page: Page, actorId: string): Promise<void> {
  await page.goto(`${BASE_URL}/__studio/actors/oven/${actorId}`);
  await expect(page.getByTestId("actor-title")).toContainText(actorId);
  await expect(page.getByTestId("status")).toHaveText("Live");
  await page.getByTestId("tab-timers").click();
}

test.describe("Studio — Timers panel", () => {
  test("a scheduled timer appears live with name, key, due-in and a redacted payload", async ({ page, request }) => {
    const ovenId = uniqueId("oven-list");
    await spawnOven(request, ovenId);
    await openTimers(page, ovenId);
    await expect(page.getByTestId("timers-panel")).toContainText("No pending timers.");

    await bake(request, ovenId, "bread", 600_000);
    const row = page.getByTestId("timer-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("done");
    await expect(row).toContainText("bake");
    await expect(row.getByTestId("timer-due")).toHaveText(/^in (9|10)m$/);
    await expect(row).toContainText("bread");
    await expect(row).toContainText("[redacted]");
    await expect(row).not.toContainText("recipe-for-bread");
    await expect(page.getByTestId("tab-timers")).toContainText("(1)");
  });

  test("Fire now runs the timer: the row goes, the state and timeline show it", async ({ page, request }) => {
    const ovenId = uniqueId("oven-fire");
    await spawnOven(request, ovenId);
    await bake(request, ovenId, "pie", 600_000);
    await openTimers(page, ovenId);
    await expect(page.getByTestId("timer-row")).toHaveCount(1);

    await page.getByRole("button", { name: "Fire bake now" }).click();
    await expect(page.getByTestId("timer-row")).toHaveCount(0);
    await expect(page.getByTestId("timers-panel")).toContainText("No pending timers.");

    await page.getByTestId("tab-state").click();
    await expect(page.getByTestId("state-panel")).toContainText("pie");
    await page.getByTestId("tab-timeline").click();
    await expect(page.getByTestId("timeline-panel")).toContainText("timer");
  });

  test("a due timer fires on its own alarm and leaves the panel", async ({ page, request }) => {
    const ovenId = uniqueId("oven-alarm");
    await spawnOven(request, ovenId);
    await openTimers(page, ovenId);
    await bake(request, ovenId, "cake", 1_500);
    await expect(page.getByTestId("timer-row")).toHaveCount(1);
    await expect(page.getByTestId("timer-row")).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId("tab-state").click();
    await expect(page.getByTestId("state-panel")).toContainText("cake");
  });
});
