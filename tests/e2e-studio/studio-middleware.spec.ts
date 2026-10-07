/**
 * Studio middleware over a real `wrangler dev` (tests/e2e-studio/worker.ts):
 * routing, prefix pass-through, phantom-actor protection and SPA deep links.
 */
import { expect, test } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
const RUN_ID = Date.now().toString(36);

test.describe("Studio middleware over wrangler dev", () => {
  test("paths that only look like the studio prefix reach the app", async ({ request }) => {
    for (const path of ["/__studiofoo", "/__studio-admin/api/actors"]) {
      const res = await request.get(`${BASE_URL}${path}`);
      expect(res.status()).toBe(200);
      expect(await res.text()).toBe("Studio E2E test worker");
    }
  });

  test("looking up an unknown actor is a JSON 404 and it never appears in the dashboard list", async ({ request }) => {
    const ghost = `ghost-${RUN_ID}`;
    for (const path of [`/__studio/api/actors/counter/${ghost}`, `/__studio/api/actors/counter/${ghost}/timeline`]) {
      const res = await request.get(`${BASE_URL}${path}`);
      expect(res.status()).toBe(404);
      expect(await res.json()).toEqual({ error: expect.stringContaining("not found") });
    }

    const list = await request.get(`${BASE_URL}/__studio/api/actors?type=counter&limit=1000`);
    expect(list.status()).toBe(200);
    const body: { actors: Array<{ actorId: string }> } = await list.json();
    expect(body.actors.some((a) => a.actorId.includes(ghost))).toBe(false);
  });

  test("a seeded actor is inspectable and invalid query params are 400", async ({ request }) => {
    const actorId = `mw-e2e-${RUN_ID}`;
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 2 } });

    const inspect = await request.get(`${BASE_URL}/__studio/api/actors/counter/${actorId}`);
    expect(inspect.status()).toBe(200);
    const state: { state: { count: number } } = await inspect.json();
    expect(state.state.count).toBe(2);

    const bad = await request.get(`${BASE_URL}/__studio/api/actors/counter/${actorId}/timeline?limit=abc`);
    expect(bad.status()).toBe(400);
  });

  test("unknown API routes are JSON 404s and writes are 405", async ({ request }) => {
    const unknown = await request.get(`${BASE_URL}/__studio/api/nope`);
    expect(unknown.status()).toBe(404);
    expect(unknown.headers()["content-type"]).toContain("application/json");

    const post = await request.post(`${BASE_URL}/__studio/api/actors`);
    expect(post.status()).toBe(405);
    expect(post.headers()["allow"]).toBe("GET, HEAD");
  });

  test("deep link to an actor whose id contains a dot loads the studio", async ({ page, request }) => {
    const actorId = `room.${RUN_ID}`;
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 4 } });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await expect(page.locator("[data-testid='actor-title']")).toContainText(actorId);
    await expect(page.locator("[data-testid='state-panel']")).toContainText("4");
  });
});
