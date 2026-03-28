import { expect, test } from "@playwright/test";

test.describe("Counter Example", () => {
  test("page loads with title and initial state", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Actor Kit Counter");
    await expect(page.locator("#count")).toBeVisible();
    await expect(page.locator("#increment")).toBeVisible();
    await expect(page.locator("#decrement")).toBeVisible();
  });

  test("shows connecting status then connected", async ({ page }) => {
    await page.goto("/");
    // Should eventually show "Connected as user-..."
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
  });

  test("increment button increases count", async ({ page }) => {
    const id = "e2e-inc-" + Date.now();
    await page.goto("/?id=" + id);
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
    // Wait for initial snapshot to arrive (count stops being "—")
    await expect(page.locator("#count")).not.toHaveText("—", { timeout: 5000 });

    await page.locator("#increment").click();
    // Count should increase from 0 to 1
    await expect(page.locator("#count")).toHaveText("1", { timeout: 3000 });
  });

  test("decrement button decreases count", async ({ page }) => {
    await page.goto("/?id=e2e-decrement");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
    await expect(page.locator("#count")).not.toHaveText("—", { timeout: 5000 });

    // Increment first to have something to decrement
    await page.locator("#increment").click();
    await page.locator("#increment").click();
    await page.waitForTimeout(500);

    const countBefore = parseInt((await page.locator("#count").textContent()) ?? "0", 10);
    expect(countBefore).toBeGreaterThanOrEqual(2);

    await page.locator("#decrement").click();
    await page.waitForTimeout(500);

    const countAfter = parseInt((await page.locator("#count").textContent()) ?? "0", 10);
    expect(countAfter).toBe(countBefore - 1);
  });

  test("shows last updated by after action", async ({ page }) => {
    await page.goto("/?id=e2e-last-updated");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
    await expect(page.locator("#count")).not.toHaveText("—", { timeout: 5000 });

    await page.locator("#increment").click();
    await page.waitForTimeout(500);

    await expect(page.locator("#last-updated")).toContainText("Last updated by: user-");
  });

  test("multiple rapid clicks all register", async ({ page }) => {
    await page.goto("/?id=e2e-rapid");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
    await expect(page.locator("#count")).not.toHaveText("—", { timeout: 5000 });

    // Click 5 times rapidly
    for (let i = 0; i < 5; i++) {
      await page.locator("#increment").click();
    }

    await page.waitForTimeout(1000);

    const count = parseInt((await page.locator("#count").textContent()) ?? "0", 10);
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test("two browsers see the same counter", async ({ browser }) => {
    const actorId = "e2e-multi-" + Date.now();

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    await page1.goto("/?id=" + actorId);
    await page2.goto("/?id=" + actorId);

    await expect(page1.locator("#status")).toContainText("Connected", { timeout: 5000 });
    await expect(page2.locator("#status")).toContainText("Connected", { timeout: 5000 });

    // Wait for initial state
    await page1.waitForTimeout(500);

    // User 1 increments
    await page1.locator("#increment").click();
    await page1.locator("#increment").click();
    await page1.locator("#increment").click();
    await page1.waitForTimeout(1000);

    // Both should see count >= 3
    const count1 = parseInt((await page1.locator("#count").textContent()) ?? "0", 10);
    expect(count1).toBeGreaterThanOrEqual(3);

    // User 2 should also see the updated count (real-time sync)
    const count2 = parseInt((await page2.locator("#count").textContent()) ?? "0", 10);
    expect(count2).toBeGreaterThanOrEqual(3);

    await context1.close();
    await context2.close();
  });
});
