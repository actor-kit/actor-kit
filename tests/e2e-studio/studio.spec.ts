import { expect, test } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";

// Use unique IDs per test run to avoid state accumulation across retries
const RUN_ID = Date.now().toString(36);
const ACTOR_A = `counter-a-${RUN_ID}`;
const ACTOR_B = `counter-b-${RUN_ID}`;

test.describe("Actor Kit Studio E2E", () => {
  test.beforeAll(async ({ request }) => {
    // Seed two actors with different state
    await request.post(`${BASE_URL}/seed`, {
      data: { actorId: ACTOR_A, count: 5 },
    });
    await request.post(`${BASE_URL}/seed`, {
      data: { actorId: ACTOR_B, count: 12 },
    });
  });

  test("studio dashboard loads and shows actor list heading", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/`);
    await expect(page.locator("text=Actor Kit Studio")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Actors" })).toBeVisible();
  });

  test("dashboard shows manual connect when no registry", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/`);
    // Without ctx.exports wired up, the registry might not list actors
    // But the manual connect UI should be available
    await expect(page.locator("[data-testid='manual-type']")).toBeVisible();
    await expect(page.locator("[data-testid='manual-id']")).toBeVisible();
  });

  test("can navigate to actor detail via manual connect", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/`);

    // Fill in manual connect
    await page.fill("[data-testid='manual-type']", "counter");
    await page.fill("[data-testid='manual-id']", ACTOR_A);
    await page.click("[data-testid='manual-connect']");

    // Should navigate to actor detail page
    await expect(page.locator("[data-testid='actor-title']")).toBeVisible();
    await expect(page.locator("[data-testid='actor-title']")).toContainText("counter");
    await expect(page.locator("[data-testid='actor-title']")).toContainText(ACTOR_A);
  });

  test("actor detail shows state panel with current state", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);

    // State tab should be active by default
    await expect(page.locator("[data-testid='state-panel']")).toBeVisible();

    // State should show count: 5
    await expect(page.locator("[data-testid='state-panel']")).toContainText("count");
    await expect(page.locator("[data-testid='state-panel']")).toContainText("5");
  });

  test("actor detail shows timeline with entries", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);

    // Click timeline tab
    await page.click("[data-testid='tab-timeline']");
    await expect(page.locator("[data-testid='timeline-panel']")).toBeVisible();

    // Should have entries (init + 5 increments = 6)
    const entries = page.locator("[data-testid^='timeline-entry-']");
    await expect(entries.first()).toBeVisible();

    // Should show cause type labels in the timeline
    const timelinePanel = page.locator("[data-testid='timeline-panel']");
    await expect(timelinePanel.locator("text=INCREMENT").first()).toBeVisible();
    await expect(timelinePanel.locator("text=Actor initialized")).toBeVisible();
  });

  test("timeline entry is expandable", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);
    await page.click("[data-testid='tab-timeline']");

    // Click the first timeline entry
    const firstEntry = page.locator("[data-testid^='timeline-entry-']").first();
    await firstEntry.click();

    // Should show cause data and state snapshot
    await expect(page.locator("text=Cause data")).toBeVisible();
    await expect(page.locator("text=State after")).toBeVisible();
  });

  test("actor detail shows connections tab", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);
    await page.click("[data-testid='tab-connections']");
    await expect(page.locator("[data-testid='connections-panel']")).toBeVisible();
    // No active connections in E2E (we're not maintaining a WS)
    await expect(page.locator("text=No active connections")).toBeVisible();
  });

  test("actor detail shows outbox tab", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);
    await page.click("[data-testid='tab-outbox']");
    await expect(page.locator("[data-testid='outbox-panel']")).toBeVisible();
    await expect(page.locator("text=No executions")).toBeVisible();
  });

  test("actor detail shows links tab", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);
    await page.click("[data-testid='tab-links']");
    await expect(page.locator("[data-testid='links-panel']")).toBeVisible();
    await expect(page.locator("text=No active links")).toBeVisible();
  });

  test("different actor shows different state", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_B}`);
    const statePanel = page.locator("[data-testid='state-panel']");
    await expect(statePanel).toBeVisible();
    await expect(statePanel).toContainText("12");
  });

  test("back link navigates to dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/actors/counter/${ACTOR_A}`);
    await page.click("text=Dashboard");
    await expect(page.getByRole("heading", { name: "Actors" })).toBeVisible();
  });
});
