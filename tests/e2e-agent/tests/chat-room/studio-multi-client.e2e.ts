/**
 * Flow: several chat-room clients (separate browser contexts, plus a second tab
 * of one user) and Studio open on the same room. Studio shows every message
 * live and counts exactly the app sockets, never itself.
 */

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { BrowserContext, Page } from "playwright";
import { launchClients, listActors, uniqueId } from "../support/clients";
import { CHAT_ROOM_PORT } from "../support/ports";

const BASE = `http://localhost:${CHAT_ROOM_PORT}`;

async function openChat(context: BrowserContext, roomId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${BASE}/chat/${roomId}`);
  await page.locator("#send-btn").waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

async function callerOf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(BASE)).find((c) => c.name === "caller_id");
  if (cookie === undefined) throw new Error("chat page set no caller_id cookie");
  return decodeURIComponent(cookie.value);
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator("#msg-input").fill(text);
  await page.locator("#send-btn").click();
  await page.locator(".msg .text", { hasText: text }).waitFor({ timeout: 10_000 });
}

test("several app clients + Studio: live messages, connection count excludes Studio", async ({ browser }) => {
  const roomId = uniqueId("multi");
  const clients = await launchClients();
  try {
    const alice = await clients.context();
    const bob = await clients.context();

    const alice1 = await openChat(alice, roomId);
    const aliceId = await callerOf(alice);

    // Studio on the same room.
    await browser.goto(`${BASE}/__studio/actors/chat-room/${roomId}`);
    await expect(browser.locator("text=Live").first()).toBeVisible({ timeout: 10_000 });
    const connectionsTab = browser.locator("[data-testid='tab-connections']");
    await expect(connectionsTab).toContainText("(1)");

    // Bob joins, and Alice opens a second tab: three app sockets.
    const bob1 = await openChat(bob, roomId);
    const bobId = await callerOf(bob);
    const alice2 = await openChat(alice, roomId);
    await expect(connectionsTab).toContainText("(3)", { timeout: 10_000 });

    await connectionsTab.click();
    const rows = browser.locator("[data-testid='connections-panel'] tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: aliceId })).toHaveCount(2);
    await expect(rows.filter({ hasText: bobId })).toHaveCount(1);

    // Every message shows up in Studio live, attributed to its sender.
    await say(alice1, "hello from alice tab 1");
    await say(bob1, "hello from bob");
    await say(alice2, "hello from alice tab 2");

    await browser.locator("[data-testid='tab-timeline']").click();
    const sent = browser.locator("[data-testid^='timeline-entry-']").filter({ hasText: "sent SEND_MESSAGE" });
    await expect(sent).toHaveCount(3, { timeout: 10_000 });
    await expect(sent.filter({ hasText: aliceId })).toHaveCount(2);
    await expect(sent.filter({ hasText: bobId })).toHaveCount(1);

    await browser.locator("[data-testid='tab-state']").click();
    const state = browser.locator("[data-testid='state-panel']");
    // Message objects sit below the tree's default open depth: expand each.
    const collapsed = browser.locator("[data-testid='state-panel'] button").filter({ hasText: "4 keys" });
    await expect(collapsed).toHaveCount(3);
    for (let i = 0; i < 3; i++) await collapsed.first().click();
    await expect(state).toContainText("hello from alice tab 1");
    await expect(state).toContainText("hello from bob");
    await expect(state).toContainText("hello from alice tab 2");

    // Alice closes one tab: her other tab is still connected.
    await alice1.close();
    await expect(connectionsTab).toContainText("(2)", { timeout: 10_000 });
    await connectionsTab.click();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: aliceId })).toHaveCount(1);
    await expect(rows.filter({ hasText: bobId })).toHaveCount(1);

    // The dashboard lists the room once, with the same count.
    await expect
      .poll(async () => (await listActors(BASE, roomId)).map((a) => `${a.actorId}:${a.connectionCount}`), {
        timeout: 10_000,
      })
      .toEqual([`${roomId}:2`]);
    await browser.goto(`${BASE}/__studio/`);
    await browser.locator("[data-testid='search-input']").fill(roomId);
    const row = browser.locator("[data-testid='actor-list'] tbody tr");
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    await expect(browser.locator("[data-testid='actor-list'] tbody tr td:nth-child(4)")).toHaveText("2");
  } finally {
    await clients.close();
  }
});
