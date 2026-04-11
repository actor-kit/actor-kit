import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function createAuction(page: Page, item = "Rare Sword") {
  await page.goto("/");
  await page.locator("#item-input").fill(item);
  await page.getByRole("button", { name: "Start Auction" }).click();
  await expect(page.locator("#item")).toBeVisible({ timeout: 10_000 });
  return page.url();
}

test.describe("Auction", () => {
  test("home page loads", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Actor Kit Auction" }),
    ).toBeVisible();
  });

  test("shows item name from search param", async ({ page }) => {
    await createAuction(page, "Magic Wand");
    await expect(page.locator("#item")).toContainText("Magic Wand", {
      timeout: 5_000,
    });
  });

  test("initial state shows zero bids", async ({ page }) => {
    await createAuction(page);
    await expect(page.locator("#highest-bid")).toHaveText("0", {
      timeout: 5_000,
    });
    await expect(page.locator("#bid-count")).toHaveText("0", {
      timeout: 5_000,
    });
  });

  test("placing a bid updates highest bid and count", async ({ page }) => {
    await createAuction(page);
    await expect(page.locator("#bid-btn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#bid-input").fill("100");
    await page.locator("#bid-btn").click();

    await expect(page.locator("#highest-bid")).toHaveText("100", {
      timeout: 5_000,
    });
    await expect(page.locator("#bid-count")).toHaveText("1", {
      timeout: 5_000,
    });
  });

  test("higher bid replaces lower bid", async ({ page }) => {
    await createAuction(page);
    await expect(page.locator("#bid-btn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#bid-input").fill("50");
    await page.locator("#bid-btn").click();
    await expect(page.locator("#highest-bid")).toHaveText("50", {
      timeout: 5_000,
    });

    await page.locator("#bid-input").fill("200");
    await page.locator("#bid-btn").click();
    await expect(page.locator("#highest-bid")).toHaveText("200", {
      timeout: 5_000,
    });
    await expect(page.locator("#bid-count")).toHaveText("2", {
      timeout: 5_000,
    });
  });

  test("two users see each other's bids in real-time", async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const auctionUrl = await createAuction(page1);
    await expect(page1.locator("#bid-btn")).toBeVisible({ timeout: 10_000 });

    await page2.goto(auctionUrl);
    await expect(page2.locator("#bid-btn")).toBeVisible({ timeout: 10_000 });

    // User 1 bids
    await page1.locator("#bid-input").fill("150");
    await page1.locator("#bid-btn").click();

    // User 2 sees the bid
    await expect(page2.locator("#highest-bid")).toHaveText("150", {
      timeout: 5_000,
    });

    // User 2 outbids
    await page2.locator("#bid-input").fill("300");
    await page2.locator("#bid-btn").click();

    // Both see updated bid
    await expect(page1.locator("#highest-bid")).toHaveText("300", {
      timeout: 5_000,
    });
    await expect(page2.locator("#highest-bid")).toHaveText("300", {
      timeout: 5_000,
    });

    await ctx1.close();
    await ctx2.close();
  });

  test("bid state persists across reload", async ({ page }) => {
    const auctionUrl = await createAuction(page);
    await expect(page.locator("#bid-btn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#bid-input").fill("500");
    await page.locator("#bid-btn").click();
    await expect(page.locator("#highest-bid")).toHaveText("500", {
      timeout: 5_000,
    });

    // Reload — SSR should show persisted state
    await page.goto(auctionUrl);
    await expect(page.locator("#highest-bid")).toHaveText("500", {
      timeout: 10_000,
    });
  });
});
