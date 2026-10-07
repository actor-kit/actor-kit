/**
 * Flow: the Durable Object restarts mid-session (the whole wrangler dev
 * process is killed and started again on the same persisted state). The open
 * Studio detail page recovers without a reload, shows no duplicate timeline
 * entries and no stale connections, and the dashboard count is correct.
 *
 * This test owns its own server on RESTART_PORT; the target's server is unused.
 */

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  launchClients,
  listActors,
  openCounterSocket,
  seedCounter,
  sendIncrement,
  timelineIds,
  uniqueId,
} from "../support/clients";
import { RESTART_PORT } from "../support/ports";
import { type DevServer, startStudioWorker } from "../support/wrangler";

const PERSIST = ".wrangler/state-e2e-agent-restart";

function idsOf(testIds: string[]): number[] {
  return testIds.map((t) => Number(t.replace("timeline-entry-", "")));
}

test("DO restart mid-session: Studio recovers, no duplicate entries, counts correct", { timeout: 180_000 }, async ({
  browser,
}) => {
  const actorId = uniqueId("restart");
  let server: DevServer = await startStudioWorker(RESTART_PORT, PERSIST);
  const base = server.baseUrl;
  const clients = await launchClients();
  try {
    await seedCounter(base, actorId, 2);
    await browser.goto(`${base}/__studio/actors/counter/${actorId}`);
    const live = browser.locator("text=Live").first();
    await expect(live).toBeVisible({ timeout: 10_000 });

    const c1 = await (await clients.context()).newPage();
    const c2 = await (await clients.context()).newPage();
    await openCounterSocket(c1, base, actorId, "before-restart-1");
    await openCounterSocket(c2, base, actorId, "before-restart-2");
    const connectionsTab = browser.locator("[data-testid='tab-connections']");
    await expect(connectionsTab).toContainText("(2)", { timeout: 10_000 });
    await expect
      .poll(async () => (await listActors(base, actorId)).map((a) => a.connectionCount), { timeout: 15_000 })
      .toEqual([2]);
    const idsBefore = await timelineIds(base, "counter", actorId);

    // Restart: every DO instance and socket dies.
    await server.stop();
    await expect(live).toBeHidden({ timeout: 10_000 });
    server = await startStudioWorker(RESTART_PORT, PERSIST);

    // The open page reconnects by itself and takes the fresh snapshot.
    await expect(live).toBeVisible({ timeout: 30_000 });
    await expect(connectionsTab).toHaveText("Connections", { timeout: 10_000 });
    await browser.locator("[data-testid='tab-timeline']").click();
    const entries = browser.locator("[data-testid^='timeline-entry-']");
    await expect(entries).toHaveCount(idsBefore.length);
    const rendered = await browser.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid^='timeline-entry-']")).map(
        (el) => el.getAttribute("data-testid") ?? "",
      ),
    );
    expect(idsOf(rendered)).toEqual(idsBefore);

    // Live again after the restart: one new entry, exactly once.
    await sendIncrement(base, actorId, "after-restart");
    await expect(entries).toHaveCount(idsBefore.length + 1, { timeout: 10_000 });
    await expect(entries.filter({ hasText: "after-restart sent INCREMENT" })).toHaveCount(1);

    // Dashboard: the dropped sockets are not counted.
    await expect
      .poll(async () => (await listActors(base, actorId)).map((a) => `${a.actorId}:${a.connectionCount}`), {
        timeout: 15_000,
      })
      .toEqual([`${actorId}:0`]);
    await browser.goto(`${base}/__studio/`);
    await browser.locator("[data-testid='search-input']").fill(actorId);
    await expect(browser.locator("[data-testid='actor-list'] tbody tr")).toHaveCount(1, { timeout: 10_000 });
    await expect(browser.locator("[data-testid='actor-list'] tbody tr td:nth-child(4)")).toHaveText("0");
  } finally {
    await clients.close();
    await server.stop();
  }
});
