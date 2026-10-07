/**
 * Flow: two Studio tabs on the same actor at once. Both receive every live
 * update, render the same timeline, never count each other as connections,
 * and closing one leaves the other live.
 */

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  launchClients,
  openCounterSocket,
  renderedTimelineIds,
  seedCounter,
  sendIncrement,
  uniqueId,
} from "../support/clients";
import { STUDIO_PORT } from "../support/ports";

const BASE = `http://localhost:${STUDIO_PORT}`;

test("two Studio tabs on one actor stay in sync and do not count each other", async ({ browser }) => {
  const actorId = uniqueId("two-tabs");
  await seedCounter(BASE, actorId, 0);
  const clients = await launchClients();
  try {
    const studioUrl = `${BASE}/__studio/actors/counter/${actorId}`;
    await browser.goto(studioUrl);
    await expect(browser.locator("text=Live").first()).toBeVisible({ timeout: 10_000 });

    const second = await (await clients.context()).newPage();
    await second.goto(studioUrl);
    await second.locator("text=Live").first().waitFor({ timeout: 10_000 });

    // Two Studio sockets, zero app connections.
    const tab1 = browser.locator("[data-testid='tab-connections']");
    await expect(tab1).toHaveText("Connections");
    await expect.poll(() => second.locator("[data-testid='tab-connections']").innerText()).toBe("Connections");

    const app = await (await clients.context()).newPage();
    await openCounterSocket(app, BASE, actorId, "watched-user");
    await expect(tab1).toContainText("(1)", { timeout: 10_000 });
    await expect
      .poll(() => second.locator("[data-testid='tab-connections']").innerText(), { timeout: 10_000 })
      .toBe("Connections(1)");

    for (const caller of ["a", "b", "c"]) await sendIncrement(BASE, actorId, `tabs-${caller}`);

    await browser.locator("[data-testid='tab-timeline']").click();
    await second.locator("[data-testid='tab-timeline']").click();
    const entries = browser.locator("[data-testid^='timeline-entry-']");
    await expect(entries).toHaveCount(4, { timeout: 10_000 }); // init + 3 messages
    const firstIds = await browser.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid^='timeline-entry-']")).map(
        (el) => el.getAttribute("data-testid") ?? "",
      ),
    );
    await expect.poll(() => renderedTimelineIds(second), { timeout: 10_000 }).toEqual(firstIds);

    // Closing one Studio tab changes nothing for the other.
    await second.close();
    await sendIncrement(BASE, actorId, "after-close");
    await expect(entries).toHaveCount(5, { timeout: 10_000 });
    await expect(entries.first()).toContainText("after-close sent INCREMENT");
    await browser.locator("[data-testid='tab-connections']").click();
    await expect(tab1).toContainText("(1)");
    await expect(browser.locator("[data-testid='connections-panel'] tbody tr")).toHaveCount(1);
  } finally {
    await clients.close();
  }
});
