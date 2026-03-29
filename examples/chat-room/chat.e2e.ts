import { expect, test } from "@playwright/test";

test.describe("Chat Room Example", () => {
  test("page loads with title", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Chat Room");
  });

  test("user can send a message", async ({ page }) => {
    const room = "e2e-send-" + Date.now();
    await page.goto("/?room=" + room + "&user=alice");
    await expect(page.locator("#info")).toContainText("alice", { timeout: 5000 });

    await page.locator("#msg-input").fill("Hello world!");
    await page.locator("#send-btn").click();

    await expect(page.locator(".msg .text")).toHaveText("Hello world!", { timeout: 3000 });
    await expect(page.locator(".msg .author")).toHaveText("alice:");
  });

  test("messages persist across page reload", async ({ page }) => {
    const room = "e2e-persist-" + Date.now();
    await page.goto("/?room=" + room + "&user=alice");
    await expect(page.locator("#info")).toContainText("alice", { timeout: 5000 });

    await page.locator("#msg-input").fill("Persistent message");
    await page.locator("#send-btn").click();
    await expect(page.locator(".msg")).toBeVisible({ timeout: 3000 });

    await page.reload();
    await expect(page.locator("#info")).toContainText("alice", { timeout: 5000 });
    await expect(page.locator(".msg .text")).toHaveText("Persistent message", { timeout: 3000 });
  });

  test("two users see each other's messages in real-time", async ({ browser }) => {
    const room = "e2e-multi-" + Date.now();

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto("/?room=" + room + "&user=alice");
    await page2.goto("/?room=" + room + "&user=bob");

    await expect(page1.locator("#info")).toContainText("alice", { timeout: 5000 });
    await expect(page2.locator("#info")).toContainText("bob", { timeout: 5000 });

    // Alice sends
    await page1.locator("#msg-input").fill("Hello from Alice");
    await page1.locator("#send-btn").click();

    // Both should see Alice's message
    await expect(page1.locator(".msg .text").first()).toHaveText("Hello from Alice", { timeout: 3000 });
    await expect(page2.locator(".msg .text").first()).toHaveText("Hello from Alice", { timeout: 3000 });

    // Bob sends
    await page2.locator("#msg-input").fill("Hi Alice!");
    await page2.locator("#send-btn").click();

    // Both should see both messages
    await expect(page1.locator(".msg")).toHaveCount(2, { timeout: 3000 });
    await expect(page2.locator(".msg")).toHaveCount(2, { timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test("shows online count", async ({ browser }) => {
    const room = "e2e-online-" + Date.now();

    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto("/?room=" + room + "&user=alice");
    await expect(page1.locator("#info")).toContainText("1 online", { timeout: 5000 });

    // Second user joins
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto("/?room=" + room + "&user=bob");
    await expect(page2.locator("#info")).toContainText("2 online", { timeout: 5000 });

    // First user should also see 2 online
    await expect(page1.locator("#info")).toContainText("2 online", { timeout: 3000 });

    await ctx1.close();
    await ctx2.close();
  });

  test("disconnect reduces online count", async ({ browser }) => {
    const room = "e2e-disconnect-" + Date.now();

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto("/?room=" + room + "&user=alice");
    await page2.goto("/?room=" + room + "&user=bob");

    // Both connected, 2 online
    await expect(page1.locator("#info")).toContainText("2 online", { timeout: 5000 });
    await expect(page2.locator("#info")).toContainText("2 online", { timeout: 5000 });

    // Bob disconnects
    await ctx2.close();

    // Alice should see count drop to 1
    await expect(page1.locator("#info")).toContainText("1 online", { timeout: 10000 });

    await ctx1.close();
  });
});
