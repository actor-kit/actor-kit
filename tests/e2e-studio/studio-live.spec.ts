/**
 * Live-update E2E coverage for Actor Kit Studio.
 *
 * Companion to studio.spec.ts, which covers static rendering. This suite
 * verifies that Studio reflects actor changes in real time WITHOUT refresh —
 * the regression surface that was broken by the broadcast-after-hibernation bug.
 */

import { expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
const RUN_ID = Date.now().toString(36);

/** Open a WebSocket from within a Playwright page so the connection lifecycle
 * is tied to the page (closing the page closes the WS). The script returns
 * once the snapshot frame arrives so the test can be sure the connection
 * has actually been registered by the actor. */
async function openClient(page: Page, actorId: string, caller: string): Promise<void> {
  await page.evaluate(
    async ({ actorId: id, caller: c, base }) => {
      const wsUrl = `${base.replace(/^http/, "ws")}/api/counter/${id}?caller=${encodeURIComponent(c)}`;
      const ws = new WebSocket(wsUrl);
      // Park the socket on the window so subsequent page.evaluate() calls can
      // close it deterministically.
      (window as unknown as { __clientWs?: WebSocket }).__clientWs = ws;
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", () => resolve(), { once: true });
        ws.addEventListener("error", (e) => reject(e), { once: true });
        ws.addEventListener("close", () => reject(new Error("ws closed before snapshot")), { once: true });
      });
    },
    { actorId, caller, base: BASE_URL },
  );
}

/** Close the WebSocket previously opened by openClient on this page. */
async function closeClient(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = (window as unknown as { __clientWs?: WebSocket }).__clientWs;
    if (w !== undefined) w.close(1000, "test done");
  });
}

test.describe("Actor Kit Studio — live updates", () => {
  test("new client WS appears in Connections tab without refresh", async ({ page, context }) => {
    const actorId = `live-conn-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-connections']");
    await expect(page.locator("[data-testid='connections-panel']")).toBeVisible();
    await expect(page.locator("text=No active connections")).toBeVisible();

    // Open a client WS from a second page; cross-page so it shares the same
    // wrangler instance but a different browser context (= different DO request).
    const clientPage = await context.newPage();
    await clientPage.goto(`${BASE_URL}/`);
    await openClient(clientPage, actorId, "live-user-1");

    // Studio should reflect the new connection live, without us reloading.
    const row = page.locator("[data-testid='connections-panel'] tbody tr").filter({ hasText: "live-user-1" });
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText("user"); // callerType column
    await expect(row).toContainText("user"); // role column (the "user" role)

    await clientPage.close();
  });

  test("connection row disappears live when client disconnects", async ({ page, context }) => {
    const actorId = `live-disconn-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-connections']");

    const clientPage = await context.newPage();
    await clientPage.goto(`${BASE_URL}/`);
    await openClient(clientPage, actorId, "live-user-disconn");

    const row = page.locator("[data-testid='connections-panel'] tbody tr").filter({ hasText: "live-user-disconn" });
    await expect(row).toBeVisible({ timeout: 5_000 });

    await closeClient(clientPage);
    await clientPage.close();

    await expect(row).toBeHidden({ timeout: 5_000 });
  });

  test("message sent to actor appears in Timeline without refresh", async ({ page, context }) => {
    const actorId = `live-timeline-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-timeline']");

    // Baseline entry count (just init)
    const entries = page.locator("[data-testid^='timeline-entry-']");
    const initialCount = await entries.count();
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Send a message — Studio should pick it up live.
    await context.request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "ts-user" } });

    await expect(async () => {
      const count = await entries.count();
      expect(count).toBe(initialCount + 1);
    }).toPass({ timeout: 5_000 });

    // Newest entry is at the top — should be the INCREMENT we just sent.
    await expect(entries.first()).toContainText("ts-user");
    await expect(entries.first()).toContainText("INCREMENT");
  });

  test("State panel updates live when actor state changes", async ({ page, context }) => {
    const actorId = `live-state-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 3 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    const statePanel = page.locator("[data-testid='state-panel']");
    await expect(statePanel).toContainText("3");

    await context.request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "state-user" } });

    await expect(statePanel).toContainText("4", { timeout: 5_000 });
    await expect(statePanel).toContainText("state-user");
  });

  test("Connections count badge updates live in tab bar", async ({ page, context }) => {
    const actorId = `live-tabbadge-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    const tab = page.locator("[data-testid='tab-connections']");
    await expect(tab).toBeVisible();
    // No badge while count is 0
    await expect(tab).not.toContainText("(");

    const c1 = await context.newPage();
    await c1.goto(`${BASE_URL}/`);
    await openClient(c1, actorId, "badge-user-1");
    await expect(tab).toContainText("(1)", { timeout: 5_000 });

    const c2 = await context.newPage();
    await c2.goto(`${BASE_URL}/`);
    await openClient(c2, actorId, "badge-user-2");
    await expect(tab).toContainText("(2)", { timeout: 5_000 });

    await closeClient(c2);
    await c2.close();
    await expect(tab).toContainText("(1)", { timeout: 5_000 });

    await closeClient(c1);
    await c1.close();
  });

  test("Connection row shows role and relative connected time", async ({ page, context }) => {
    const actorId = `live-row-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-connections']");

    const clientPage = await context.newPage();
    await clientPage.goto(`${BASE_URL}/`);
    await openClient(clientPage, actorId, "row-user");

    const row = page.locator("[data-testid='connections-panel'] tbody tr").filter({ hasText: "row-user" });
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Header row should announce the four columns we now expose.
    const headers = page.locator("[data-testid='connections-panel'] thead th");
    await expect(headers.nth(0)).toContainText("Caller");
    await expect(headers.nth(1)).toContainText("Type");
    await expect(headers.nth(2)).toContainText("Role");
    await expect(headers.nth(3)).toContainText("Connected");

    // Role cell contains the matched role.
    const roleCell = row.locator("td").nth(2);
    await expect(roleCell).toContainText("user");

    // Connected cell shows relative time (e.g. "just now", "Ns ago").
    const connectedCell = row.locator("td").nth(3);
    await expect(connectedCell).toContainText(/just now|ago/);

    await closeClient(clientPage);
    await clientPage.close();
  });

  test("multiple studio sessions all receive the same live broadcast", async ({ context }) => {
    const actorId = `live-multi-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 1 } });

    const studio1 = await context.newPage();
    const studio2 = await context.newPage();
    await Promise.all([
      studio1.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`),
      studio2.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`),
    ]);

    // Both observers start at count: 1
    await expect(studio1.locator("[data-testid='state-panel']")).toContainText("1");
    await expect(studio2.locator("[data-testid='state-panel']")).toContainText("1");

    await context.request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "multi-user" } });

    await expect(studio1.locator("[data-testid='state-panel']")).toContainText("2", { timeout: 5_000 });
    await expect(studio2.locator("[data-testid='state-panel']")).toContainText("2", { timeout: 5_000 });

    await studio1.close();
    await studio2.close();
  });

  test("rapid message bursts all stream into Timeline without dropping", async ({ page, context }) => {
    const actorId = `live-burst-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-timeline']");

    const entries = page.locator("[data-testid^='timeline-entry-']");
    const baseline = await entries.count();

    // Fire 10 increments serially (they go through DO so they serialize anyway).
    for (let i = 0; i < 10; i++) {
      await context.request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: `burst-${i}` } });
    }

    await expect(async () => {
      const count = await entries.count();
      expect(count).toBe(baseline + 10);
    }).toPass({ timeout: 10_000 });

    // State should reflect the final count too.
    await page.click("[data-testid='tab-state']");
    await expect(page.locator("[data-testid='state-panel']")).toContainText("10", { timeout: 5_000 });
  });

  test("expanding a live-added timeline entry shows diff and cause data", async ({ page, context }) => {
    const actorId = `live-expand-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 2 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-timeline']");

    const entries = page.locator("[data-testid^='timeline-entry-']");
    const baseline = await entries.count();

    await context.request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "expand-user" } });
    await expect(async () => {
      expect(await entries.count()).toBe(baseline + 1);
    }).toPass({ timeout: 5_000 });

    await entries.first().click();

    await expect(page.locator("text=Cause data")).toBeVisible();
    await expect(page.locator("text=State after")).toBeVisible();
    await expect(page.locator("text=Changes:")).toBeVisible();
    // The newly-added entry's diff should reference the updated caller.
    await expect(page.locator("text=expand-user").first()).toBeVisible();
  });

  test("Live indicator turns green when studio WS is connected", async ({ page, context }) => {
    const actorId = `live-indicator-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);

    // The "Live" badge appears once the studio WS hook reports connected.
    await expect(page.locator("text=Live").first()).toBeVisible({ timeout: 5_000 });
  });

  test("studio for actor A does not see events from actor B", async ({ page, context }) => {
    const actorA = `iso-a-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    const actorB = `iso-b-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId: actorA, count: 0 } });
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId: actorB, count: 0 } });

    // Watch actor A
    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorA}`);
    await page.click("[data-testid='tab-timeline']");
    const entries = page.locator("[data-testid^='timeline-entry-']");
    const baselineA = await entries.count();

    // Send to actor B — A's timeline must NOT grow.
    await context.request.post(`${BASE_URL}/send/${actorB}`, { data: { caller: "iso-user" } });

    // Wait a little to ensure no rogue broadcast lands.
    await page.waitForTimeout(1000);
    expect(await entries.count()).toBe(baselineA);

    // Now confirm A still works by sending to A and seeing the entry.
    await context.request.post(`${BASE_URL}/send/${actorA}`, { data: { caller: "iso-user" } });
    await expect(async () => {
      expect(await entries.count()).toBe(baselineA + 1);
    }).toPass({ timeout: 5_000 });
  });

  test("client connection persisted on snapshot survives page reload", async ({ page, context }) => {
    const actorId = `live-persist-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
    await context.request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });

    const clientPage = await context.newPage();
    await clientPage.goto(`${BASE_URL}/`);
    await openClient(clientPage, actorId, "persist-user");

    // Open Studio AFTER the client connected — the snapshot should already
    // include the connection (i.e. it's persisted in SQLite, not only pushed
    // via the live broadcast).
    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await page.click("[data-testid='tab-connections']");

    const row = page.locator("[data-testid='connections-panel'] tbody tr").filter({ hasText: "persist-user" });
    await expect(row).toBeVisible({ timeout: 5_000 });

    await closeClient(clientPage);
    await clientPage.close();
  });
});
