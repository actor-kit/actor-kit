/**
 * Flow: Studio is opened on an actor that does not exist yet, then the app
 * creates it. Desired behaviour (orchestrator, 2026-10-07):
 * - first, a not-found state: Studio does not create the actor by looking at
 *   it (middleware 404, branch worktree-agent-a7d544f9baadaa517 / 4881e32);
 * - then, once the app spawns it, the open page goes live without a reload
 *   (UI retry, area 4);
 * - the dashboard lists the actor once, under its name.
 */

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { launchClients, listActors, openCounterSocket, seedCounter, uniqueId } from "../support/clients";
import { STUDIO_PORT } from "../support/ports";

const BASE = `http://localhost:${STUDIO_PORT}`;

test("Studio opened before the actor exists goes live once the actor is created", async ({ browser }) => {
  const actorId = uniqueId("not-yet");
  const clients = await launchClients();
  try {
    await browser.goto(`${BASE}/__studio/actors/counter/${actorId}`);

    // Not found yet: no state, and looking did not create it.
    await expect(browser.locator("[data-testid='state-panel']")).toBeHidden({ timeout: 3_000 });
    expect(await listActors(BASE, actorId)).toEqual([]);

    // The app creates it and a client connects.
    await seedCounter(BASE, actorId, 2);
    const client = await (await clients.context()).newPage();
    await openCounterSocket(client, BASE, actorId, "creator");

    // The page that was already open goes live by itself.
    await expect(browser.locator("text=Live").first()).toBeVisible({ timeout: 15_000 });
    await expect(browser.locator("[data-testid='state-panel']")).toContainText("count : 2");
    await expect(browser.locator("[data-testid='tab-connections']")).toContainText("(1)", { timeout: 10_000 });

    // Listed once, by name.
    await expect
      .poll(async () => (await listActors(BASE, actorId)).map((a) => a.actorId), { timeout: 15_000 })
      .toEqual([actorId]);
  } finally {
    await clients.close();
  }
});
