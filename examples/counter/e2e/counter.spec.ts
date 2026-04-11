import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Helper: navigate to home and create a new counter
async function createCounter(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New Counter" }).click();
  // Wait for the counter display to be visible (SSR + hydration)
  await expect(page.locator("#count")).toBeVisible({ timeout: 10_000 });
  return page.url();
}

// Helper: click increment and wait for the count to reach the expected value.
// React + WebSocket round-trip means each click needs the UI to settle before the next.
async function clickIncrement(page: Page, expectedCount: number) {
  await page.locator("#increment").click();
  await expect(page.locator("#count")).toHaveText(String(expectedCount), {
    timeout: 5_000,
  });
}

test.describe("Counter page", () => {
  test("home page loads with title", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Actor Kit Counter" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Counter" }),
    ).toBeVisible();
  });

  test("navigating to counter shows initial count", async ({ page }) => {
    await createCounter(page);
    await expect(page.locator("#count")).toHaveText("0", { timeout: 10_000 });
  });

  test("increment button increases count", async ({ page }) => {
    await createCounter(page);
    // Wait for hydration — buttons become enabled
    await expect(page.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    await page.locator("#increment").click();
    await expect(page.locator("#count")).toHaveText("1", { timeout: 5_000 });
  });

  test("decrement button decreases count", async ({ page }) => {
    await createCounter(page);
    await expect(page.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    // Increment twice, waiting for each to settle (React + WS round-trip)
    await clickIncrement(page, 1);
    await clickIncrement(page, 2);

    // Decrement once
    await page.locator("#decrement").click();
    await expect(page.locator("#count")).toHaveText("1", { timeout: 5_000 });
  });

  test("shows last updated by after action", async ({ page }) => {
    await createCounter(page);
    await expect(page.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    await page.locator("#increment").click();
    await expect(page.locator("#last-updated")).toContainText(
      "Last updated by: user-",
      { timeout: 5_000 },
    );
  });

  test("multiple clicks all register", async ({ page }) => {
    await createCounter(page);
    await expect(page.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    // Wait for each click to settle through the React + WebSocket round-trip
    for (let i = 1; i <= 5; i++) {
      await clickIncrement(page, i);
    }
  });
});

test.describe("Persistence", () => {
  test("count survives page reload", async ({ page }) => {
    const counterUrl = await createCounter(page);
    await expect(page.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    // Wait for each click to settle through the React + WebSocket round-trip
    await clickIncrement(page, 1);
    await clickIncrement(page, 2);
    await clickIncrement(page, 3);

    // Reload — SSR should render the persisted state
    await page.goto(counterUrl);
    await expect(page.locator("#count")).toHaveText("3", { timeout: 10_000 });
  });
});

test.describe("Multi-client sync", () => {
  test("two browsers see the same counter", async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const counterUrl = await createCounter(page1);
    await expect(page1.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    // Page 2 opens the same counter
    await page2.goto(counterUrl);
    await expect(page2.locator("#count")).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator("#increment")).toBeEnabled({ timeout: 10_000 });

    // Page 1 increments 3 times, waiting for each to settle
    await clickIncrement(page1, 1);
    await clickIncrement(page1, 2);
    await clickIncrement(page1, 3);

    // Page 2 should also see count of 3 via real-time sync
    await expect(page2.locator("#count")).toHaveText("3", { timeout: 10_000 });

    // Page 2 decrements once
    await page2.locator("#decrement").click();

    // Both should see count of 2
    await expect(page1.locator("#count")).toHaveText("2", { timeout: 10_000 });
    await expect(page2.locator("#count")).toHaveText("2", { timeout: 10_000 });

    await context1.close();
    await context2.close();
  });
});

test.describe("Navigation", () => {
  test("Home link returns to homepage", async ({ page }) => {
    await createCounter(page);
    await page.getByRole("link", { name: "Home" }).click();
    await expect(
      page.getByRole("button", { name: "New Counter" }),
    ).toBeVisible();
  });

  test("each New Counter creates a unique counter", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New Counter" }).click();
    const firstUrl = page.url();

    await page.goto("/");
    await page.getByRole("button", { name: "New Counter" }).click();
    const secondUrl = page.url();

    expect(firstUrl).not.toEqual(secondUrl);
  });
});
