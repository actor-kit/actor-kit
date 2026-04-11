import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function createChatRoom(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New Chat Room" }).click();
  await expect(page.locator("#messages")).toBeVisible({ timeout: 10_000 });
  return page.url();
}

test.describe("Chat Room", () => {
  test("home page loads", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Actor Kit Chat Room" }),
    ).toBeVisible();
  });

  test("user can send a message", async ({ page }) => {
    await createChatRoom(page);
    await expect(page.locator("#send-btn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#msg-input").fill("Hello world");
    await page.locator("#send-btn").click();

    await expect(page.locator(".msg .text")).toContainText("Hello world", {
      timeout: 5_000,
    });
  });

  test("messages persist across page reload", async ({ page }) => {
    const chatUrl = await createChatRoom(page);
    await expect(page.locator("#send-btn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#msg-input").fill("Persistent message");
    await page.locator("#send-btn").click();
    await expect(page.locator(".msg .text")).toContainText(
      "Persistent message",
      { timeout: 5_000 },
    );

    // Reload — SSR should render the persisted messages
    await page.goto(chatUrl);
    await expect(page.locator(".msg .text")).toContainText(
      "Persistent message",
      { timeout: 10_000 },
    );
  });

  test("two users see each other's messages in real-time", async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const chatUrl = await createChatRoom(page1);
    await expect(page1.locator("#send-btn")).toBeVisible({ timeout: 10_000 });

    await page2.goto(chatUrl);
    await expect(page2.locator("#send-btn")).toBeVisible({ timeout: 10_000 });

    // User 1 sends
    await page1.locator("#msg-input").fill("Message from user 1");
    await page1.locator("#send-btn").click();

    // User 2 should see it
    await expect(page2.locator(".msg .text").last()).toContainText(
      "Message from user 1",
      { timeout: 5_000 },
    );

    // User 2 sends back
    await page2.locator("#msg-input").fill("Reply from user 2");
    await page2.locator("#send-btn").click();

    // User 1 should see both
    await expect(page1.locator(".msg")).toHaveCount(2, { timeout: 5_000 });

    await ctx1.close();
    await ctx2.close();
  });
});
