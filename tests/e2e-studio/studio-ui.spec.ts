/**
 * Studio UI browser flows against a real Studio worker: dashboard search,
 * filter and pagination; manual connect; error states; live timeline;
 * reconnect after a network blip and after a server restart; socket cleanup.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";

const BASE_URL = process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
const RUN_ID = Date.now().toString(36);
const STUDIO_WS = /\/__studio\/actors\/[^/]+\/[^/]+\/ws$/;

function uniqueId(prefix: string): string {
  return `${prefix}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Track the page's studio WebSockets from inside the page, so tests can assert
 * none leak. A socket stuck in CLOSING (server never answered the close frame)
 * counts as open. (Playwright's own WebSocket events don't report close for
 * routed sockets, so the page's readyState is the source of truth.)
 */
async function trackSockets(page: Page): Promise<{ total: () => Promise<number>; open: () => Promise<number> }> {
  await page.addInitScript((pattern) => {
    const re = new RegExp(pattern);
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.defineProperty(window, "__studioSockets", { value: sockets });
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (re.test(String(url))) sockets.push(this);
      }
    };
  }, STUDIO_WS.source);
  const read = (onlyOpen: boolean) =>
    page.evaluate((open) => {
      const sockets: unknown = Reflect.get(window, "__studioSockets");
      if (!Array.isArray(sockets)) return 0;
      return sockets.filter((ws) => !open || (ws instanceof WebSocket && ws.readyState !== WebSocket.CLOSED)).length;
    }, onlyOpen);
  return { total: () => read(false), open: () => read(true) };
}

async function expectUniqueTimelineIds(page: Page): Promise<void> {
  const ids = await page
    .locator("[data-testid^='timeline-entry-']")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(ids).not.toContain("timeline-entry-undefined");
  expect(new Set(ids).size).toBe(ids.length);
}

test.describe("Studio UI — dashboard", () => {
  test("search, type filter and pagination over the registry", async ({ page, request }) => {
    const prefix = `pg-${RUN_ID}`;
    for (let i = 0; i < 52; i++) {
      await request.post(`${BASE_URL}/seed`, {
        data: { actorId: `${prefix}-${String(i).padStart(2, "0")}`, count: 0 },
      });
    }

    await page.goto(`${BASE_URL}/__studio/`);
    await page.fill("[data-testid='search-input']", prefix);
    const links = page.locator("[data-testid^='actor-link-']");
    await expect(links).toHaveCount(50, { timeout: 15_000 });
    await expect(page.getByTestId("page-info")).toHaveText("1–50");

    await page.getByTestId("page-next").click();
    await expect(links).toHaveCount(2);
    await expect(page.getByTestId("page-info")).toHaveText("51–52");
    await expect(page.getByTestId("page-next")).toBeDisabled();

    await page.getByTestId("page-prev").click();
    await expect(links).toHaveCount(50);

    await page.selectOption("[data-testid='type-filter']", "counter");
    await page.fill("[data-testid='search-input']", `${prefix}-07`);
    await expect(links).toHaveCount(1);
    await expect(page.getByTestId("page-next")).toHaveCount(0);

    await page.fill("[data-testid='search-input']", `${prefix}-nothing`);
    await expect(page.getByText("No actors found.")).toBeVisible();
  });

  test("manual connect: disabled when empty, navigates when filled", async ({ page, request }) => {
    const actorId = uniqueId("manual");
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 2 } });

    await page.goto(`${BASE_URL}/__studio/`);
    await expect(page.getByTestId("manual-connect")).toBeDisabled();
    await page.fill("[data-testid='manual-type']", "counter");
    await expect(page.getByTestId("manual-connect")).toBeDisabled();
    await page.fill("[data-testid='manual-id']", `  ${actorId}  `);
    await page.press("[data-testid='manual-id']", "Enter");

    await expect(page.getByTestId("actor-title")).toContainText(actorId);
    await expect(page.getByTestId("state-panel")).toContainText("count:2");
  });

  test("manual connect to an unknown actor type shows an error, not an endless spinner", async ({ page }) => {
    await page.goto(`${BASE_URL}/__studio/`);
    await page.fill("[data-testid='manual-type']", "nope");
    await page.fill("[data-testid='manual-id']", "x");
    await page.click("[data-testid='manual-connect']");
    await expect(page.getByRole("alert")).toContainText('Actor type "nope" not found');
    await expect(page.getByText("Connecting...")).toHaveCount(0);
  });
});

test.describe("Studio UI — actor detail", () => {
  test("live entries are distinct: expanding one expands only that one", async ({ page, request }) => {
    const actorId = uniqueId("live-expand");
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });
    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await expect(page.getByTestId("status")).toHaveText("Live");
    await page.click("[data-testid='tab-timeline']");

    await request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "first" } });
    await request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "second" } });
    const entries = page.locator("[data-testid^='timeline-entry-']");
    await expect(entries.first()).toContainText("second sent INCREMENT");
    await expectUniqueTimelineIds(page);

    await entries.first().click();
    await expect(page.getByText("Cause data:")).toHaveCount(1);
    await expect(page.getByTestId("timeline-panel")).toContainText("count1→2");
  });

  test("reconnects after a network blip without duplicating entries or leaking sockets", async ({ page, request }) => {
    const actorId = uniqueId("blip");
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 1 } });

    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(STUDIO_WS, (ws) => {
      ws.connectToServer();
      routes.push(ws);
    });
    const sockets = await trackSockets(page);

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await expect(page.getByTestId("status")).toHaveText("Live");
    await page.click("[data-testid='tab-timeline']");
    const entries = page.locator("[data-testid^='timeline-entry-']");
    const before = await entries.count();

    await routes[0]?.close({ code: 1006, reason: "blip" });
    await expect(page.getByTestId("status")).toHaveText("Reconnecting...");
    await expect(page.getByTestId("status")).toHaveText("Live", { timeout: 10_000 });
    expect(routes).toHaveLength(2);

    await expect(entries).toHaveCount(before);
    await request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "after-blip" } });
    await expect(entries).toHaveCount(before + 1);
    await expect(entries.first()).toContainText("after-blip");
    await expectUniqueTimelineIds(page);
    expect(await sockets.open()).toBe(1);
  });

  test("a malformed frame shows an error banner and the page keeps working", async ({ page, request }) => {
    const actorId = uniqueId("malformed");
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 4 } });

    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(STUDIO_WS, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => ws.send(message));
      routes.push(ws);
    });

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await expect(page.getByTestId("state-panel")).toContainText("count:4");

    routes[0]?.send("{this is not json");
    await expect(page.getByRole("alert")).toContainText("Malformed studio frame");
    routes[0]?.send(JSON.stringify({ type: "studio.timeline", entry: { id: 1, causeType: "message" } }));
    await expect(page.getByRole("alert")).toContainText("Invalid studio.timeline frame");
    await expect(page.getByTestId("state-panel")).toContainText("count:4");

    // Real frames still apply afterwards.
    await request.post(`${BASE_URL}/send/${actorId}`, { data: { caller: "still-alive" } });
    await expect(page.getByTestId("state-panel")).toContainText("count:5");
  });

  test("navigating back to the dashboard closes the studio socket", async ({ page, request }) => {
    const actorId = uniqueId("nav-close");
    await request.post(`${BASE_URL}/seed`, { data: { actorId, count: 0 } });
    const sockets = await trackSockets(page);

    await page.goto(`${BASE_URL}/__studio/actors/counter/${actorId}`);
    await expect(page.getByTestId("status")).toHaveText("Live");
    expect(await sockets.open()).toBe(1);

    await page.getByText("← Dashboard").click();
    await expect(page.getByRole("heading", { name: "Actors" })).toBeVisible();
    await expect.poll(() => sockets.open()).toBe(0);
    expect(await sockets.total()).toBe(1);
  });
});

// --- Server restart: this test runs its own worker so it can stop and restart it ---

/** Base port for the restartable worker; each parallel Playwright worker adds its index. */
const RESTART_BASE_PORT = Number(process.env["STUDIO_E2E_RESTART_PORT"] ?? "8809");

interface RestartableWorker {
  url: string;
  start: () => void;
  stop: () => Promise<void>;
  isUp: () => Promise<boolean>;
}

/** SIGKILL every process listening on `port` (lsof on macOS and Linux); nothing when none is. */
function killListeners(port: number): void {
  let pids: string[] = [];
  try {
    pids = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return; // lsof exits 1 when nothing listens
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function restartableWorker(index: number): RestartableWorker {
  const port = RESTART_BASE_PORT + index;
  const url = `http://localhost:${port}`;
  let child: ChildProcess | null = null;

  const downWithin = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!(await isUp())) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };

  const isUp = async () => {
    try {
      return (await fetch(`${url}/`)).ok;
    } catch {
      return false;
    }
  };

  return {
    url,
    isUp,
    start() {
      child = spawn(
        "pnpm",
        [
          "exec",
          "wrangler",
          "dev",
          "--persist-to",
          `.wrangler/restart-state-${index}`,
          "--port",
          String(port),
          "--inspector-port",
          "0",
        ],
        { cwd: import.meta.dirname, detached: true, stdio: "ignore" },
      );
    },
    async stop() {
      const running = child;
      child = null;
      if (running === null || running.pid === undefined || running.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
      process.kill(-running.pid, "SIGTERM");
      await exited;
      if (await downWithin(5_000)) return;
      // On the Linux CI runner the port was still served 10 s after the group's SIGTERM: workerd
      // outlived wrangler. Kill whatever still listens on the port.
      killListeners(port);
      await expect.poll(isUp, { timeout: 10_000 }).toBe(false);
    },
  };
}

test.describe("Studio UI — server restart", () => {
  let worker: RestartableWorker | null = null;

  test.afterEach(async () => {
    await worker?.stop();
    worker = null;
  });

  test("reconnects after the worker restarts and keeps the timeline consistent", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const server = restartableWorker(testInfo.parallelIndex);
    worker = server;
    server.start();
    await expect.poll(server.isUp, { timeout: 60_000 }).toBe(true);

    const actorId = uniqueId("restart");
    await page.request.post(`${server.url}/seed`, { data: { actorId, count: 2 } });
    const sockets = await trackSockets(page);

    await page.goto(`${server.url}/__studio/actors/counter/${actorId}`);
    await expect(page.getByTestId("status")).toHaveText("Live");
    await page.click("[data-testid='tab-timeline']");
    const entries = page.locator("[data-testid^='timeline-entry-']");
    const before = await entries.count();

    await server.stop();
    await expect(page.getByTestId("status")).not.toHaveText("Live");
    // Last known data stays on screen while the server is down.
    await expect(entries).toHaveCount(before);

    server.start();
    await expect.poll(server.isUp, { timeout: 60_000 }).toBe(true);
    await expect(page.getByTestId("status")).toHaveText("Live", { timeout: 30_000 });
    await expect(entries).toHaveCount(before);

    await page.request.post(`${server.url}/send/${actorId}`, { data: { caller: "after-restart" } });
    await expect(entries.first()).toContainText("after-restart");
    await expect(entries).toHaveCount(before + 1);
    await expectUniqueTimelineIds(page);
    await page.click("[data-testid='tab-state']");
    await expect(page.getByTestId("state-panel")).toContainText("count:3");
    expect(await sockets.open()).toBe(1);
  });
});
