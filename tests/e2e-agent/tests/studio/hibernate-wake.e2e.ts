/**
 * Flow: every app client goes away, the actor idles (and may hibernate), then
 * wakes on a new message. Studio stays live and its timeline is continuous.
 *
 * Whether local workerd actually evicts the idle actor during the wait is not
 * observable from here; the eviction itself is covered deterministically at the
 * DO seam by tests/integration/studio-live.test.ts (evictDurableObject).
 */

import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  closeCounterSocket,
  launchClients,
  openCounterSocket,
  seedCounter,
  sendIncrement,
  timelineIds,
  uniqueId,
} from "../support/clients";
import { STUDIO_PORT } from "../support/ports";

const BASE = `http://localhost:${STUDIO_PORT}`;
const IDLE_MS = 12_000;

async function renderedIds(browser: Browser): Promise<string[]> {
  return browser.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid^='timeline-entry-']")).map(
      (el) => el.getAttribute("data-testid") ?? "",
    ),
  );
}

test("actor idles with no app clients and wakes: Studio still live, timeline continuous", async ({ browser }) => {
  const actorId = uniqueId("hibernate");
  await seedCounter(BASE, actorId, 1);
  const clients = await launchClients();
  try {
    await browser.goto(`${BASE}/__studio/actors/counter/${actorId}`);
    await expect(browser.locator("text=Live").first()).toBeVisible({ timeout: 10_000 });
    const connectionsTab = browser.locator("[data-testid='tab-connections']");

    const c1 = await (await clients.context()).newPage();
    const c2 = await (await clients.context()).newPage();
    await openCounterSocket(c1, BASE, actorId, "sleepy-1");
    await openCounterSocket(c2, BASE, actorId, "sleepy-2");
    await expect(connectionsTab).toContainText("(2)", { timeout: 10_000 });

    // All app clients leave; only Studio is attached while the actor idles.
    await closeCounterSocket(c1);
    await closeCounterSocket(c2);
    await expect(connectionsTab).toHaveText("Connections", { timeout: 10_000 });

    await browser.locator("[data-testid='tab-timeline']").click();
    const before = await renderedIds(browser);
    expect(before.map((t) => Number(t.replace("timeline-entry-", "")))).toEqual(
      await timelineIds(BASE, "counter", actorId),
    );

    await new Promise((r) => setTimeout(r, IDLE_MS));

    // Wake it with a message: Studio receives it live, with no gap and no duplicate.
    await sendIncrement(BASE, actorId, "waker");
    const entries = browser.locator("[data-testid^='timeline-entry-']");
    await expect(entries).toHaveCount(before.length + 1, { timeout: 10_000 });
    await expect(entries.first()).toContainText("waker sent INCREMENT");
    await expect(browser.locator("text=Live").first()).toBeVisible();

    const after = await renderedIds(browser);
    expect(after.slice(1)).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
    expect(after.map((t) => Number(t.replace("timeline-entry-", "")))).toEqual(
      await timelineIds(BASE, "counter", actorId),
    );

    await browser.locator("[data-testid='tab-state']").click();
    await expect(browser.locator("[data-testid='state-panel']")).toContainText("count : 2");

    // A client returning after the wake is counted again, live.
    const c3 = await (await clients.context()).newPage();
    await openCounterSocket(c3, BASE, actorId, "sleepy-3");
    await expect(connectionsTab).toContainText("(1)", { timeout: 10_000 });
  } finally {
    await clients.close();
  }
});
