/**
 * Scripted Actor Kit Studio walkthrough, recorded as a screen video.
 *
 * Runs against examples/chat-room (Studio wired in via src/worker.ts and
 * `studio: { enabled: true }` in src/chat.ts). Everything on screen is real:
 * chat users are separate browser contexts that join rooms and send messages
 * through the example's own UI; nothing is mocked and no frames are injected.
 * The only thing added to the recorded page is a caption bar at the bottom.
 *
 * Usage (from the repo root):
 *   pnpm record:studio
 *
 * Outputs (gitignored):
 *   recordings/studio-walkthrough.webm / .mp4  — the Studio page video
 *   recordings/shots/NN-*.png                  — one screenshot per step
 *   recordings/shots/findings.json             — anything that did not behave as expected
 *   recordings/chat-room-dev.log               — wrangler dev output
 *
 * Anything that does not behave as expected is captioned "BUG:" on camera and
 * listed in findings.json; the walkthrough carries on so the rest is recorded.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAT_DIR = join(ROOT, "examples/chat-room");
const OUT_DIR = join(ROOT, "recordings");
const STATE_DIR = join(OUT_DIR, ".state/chat-room");
const SHOTS_DIR = join(OUT_DIR, "shots");
const VIDEO_TMP = join(OUT_DIR, ".state/video");
const LOG_FILE = join(OUT_DIR, "chat-room-dev.log");
const WEBM = join(OUT_DIR, "studio-walkthrough.webm");
const MP4 = join(OUT_DIR, "studio-walkthrough.mp4");
const WRANGLER = join(CHAT_DIR, "node_modules/.bin/wrangler");

const PORT = Number(process.env["STUDIO_RECORD_PORT"] ?? "8860");
const BASE = `http://localhost:${PORT}`;
const STUDIO = `${BASE}/__studio/`;
const SIZE = { width: 1440, height: 900 };
const ACTOR_TYPE = "chat-room";
const GHOST_ID = "ghost-room-404";

// ---------------------------------------------------------------------------
// Server lifecycle (only the process group this script started is touched)
// ---------------------------------------------------------------------------

let server: ChildProcess | null = null;

function startServer(): ChildProcess {
  const log = openSync(LOG_FILE, "a");
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "-c",
      ".output/server/wrangler.json",
      "--persist-to",
      STATE_DIR,
      "--port",
      String(PORT),
      "--inspector-port",
      "0",
    ],
    {
      cwd: CHAT_DIR,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  closeSync(log);
  server = child;
  return child;
}

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(`${BASE}/__studio/api/actors/types`)) return;
    if (server !== null && server.exitCode !== null) throw new Error(`wrangler exited early; see ${LOG_FILE}`);
    await sleep(500);
  }
  throw new Error(`server on ${BASE} did not answer within ${timeoutMs}ms; see ${LOG_FILE}`);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone.
  }
}

async function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (child === null) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    signalGroup(child, "SIGTERM");
    const timedOut = await Promise.race([exited.then(() => false), sleep(8000).then(() => true)]);
    if (timedOut) signalGroup(child, "SIGKILL");
  }
  // workerd children share the group; make sure nothing still answers on the port.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await answers(`${BASE}/__studio/api/actors/types`))) {
    signalGroup(child, "SIGKILL");
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

interface Finding {
  step: string;
  expected: string;
  observed: string;
  screenshot: string;
}

const findings: Finding[] = [];
let shotIndex = 0;
let currentStep = "";

/** Caption bar: fixed to the bottom edge, mounted on every load, text kept in sessionStorage. */
function installCaptionBar(): void {
  const mount = (): void => {
    if (document.getElementById("__walkthrough_caption") !== null) return;
    const bar = document.createElement("div");
    bar.id = "__walkthrough_caption";
    bar.style.cssText = [
      "position:fixed",
      "left:0",
      "right:0",
      "bottom:0",
      "z-index:2147483647",
      "padding:14px 24px",
      "font:600 20px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif",
      "letter-spacing:0.01em",
      "color:#f4f4f5",
      "background:rgba(24,24,27,0.94)",
      "border-top:2px solid #38bdf8",
      "pointer-events:none",
    ].join(";");
    const saved = sessionStorage.getItem("__walkthrough_caption");
    bar.textContent = saved ?? "";
    if (sessionStorage.getItem("__walkthrough_caption_bug") === "1") bar.style.borderTopColor = "#f87171";
    document.body.appendChild(bar);
    document.body.style.paddingBottom = "80px";
  };
  if (document.body !== null) mount();
  else document.addEventListener("DOMContentLoaded", mount);
}

async function caption(page: Page, text: string, bug = false): Promise<void> {
  currentStep = text;
  console.log(`${bug ? "  !! " : "  > "}${text}`);
  await page.evaluate(
    ({ t, isBug }) => {
      sessionStorage.setItem("__walkthrough_caption", t);
      sessionStorage.setItem("__walkthrough_caption_bug", isBug ? "1" : "0");
      const bar = document.getElementById("__walkthrough_caption");
      if (bar !== null) {
        bar.textContent = t;
        bar.style.borderTopColor = isBug ? "#f87171" : "#38bdf8";
      }
    },
    { t: text, isBug: bug },
  );
}

async function shot(page: Page, name: string): Promise<string> {
  shotIndex++;
  const file = join(SHOTS_DIR, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Waits for a condition; on failure, captions it as a bug on camera and records a finding. */
async function expectOnCamera(
  page: Page,
  expected: string,
  check: () => Promise<unknown>,
  observe: () => Promise<string>,
): Promise<boolean> {
  try {
    await check();
    return true;
  } catch {
    const observed = await observe().catch(() => "could not read page state");
    const step = currentStep;
    await caption(page, `BUG: expected ${expected}; saw ${observed}`, true);
    const screenshot = await shot(page, "bug");
    findings.push({ step, expected, observed, screenshot });
    await page.waitForTimeout(3000);
    await caption(page, step);
    return false;
  }
}

const textOf = (locator: Locator) => async (): Promise<string> => {
  const text = await locator.innerText({ timeout: 1000 });
  return JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 160));
};

// ---------------------------------------------------------------------------
// Chat users (separate, unrecorded browser contexts driving the example's UI)
// ---------------------------------------------------------------------------

async function chatUser(browser: Browser, name: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  // The example identifies callers by the caller_id cookie (see server/middleware/actor-kit.ts).
  await context.addCookies([{ name: "caller_id", value: name, url: BASE }]);
  return context;
}

/** Resolves once a chat-room WebSocket on this page receives a frame; attempts that fail (server down) are skipped. */
async function waitForLiveSocket(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = await page.waitForEvent("websocket", {
      predicate: (socket) => socket.url().includes("/api/chat-room/"),
      timeout: Math.max(1, deadline - Date.now()),
    });
    try {
      await ws.waitForEvent("framereceived", { timeout: Math.max(1, deadline - Date.now()) });
      return;
    } catch {
      // This attempt closed without a frame (e.g. the server was down); wait for the next one.
    }
  }
  throw new Error(`no live chat-room socket within ${timeoutMs}ms`);
}

async function joinRoom(context: BrowserContext, room: string): Promise<Page> {
  const page = await context.newPage();
  const live = waitForLiveSocket(page, 20_000);
  await page.goto(`${BASE}/chat/${room}`);
  await live;
  return page;
}

async function say(chat: Page, text: string): Promise<void> {
  await chat.locator("#msg-input").fill(text);
  await chat.locator("#msg-input").press("Enter");
  await chat.locator(".msg .text", { hasText: text }).waitFor({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Walkthrough
// ---------------------------------------------------------------------------

async function walkthrough(browser: Browser, studio: Page): Promise<void> {
  const pause = (ms = 2000) => studio.waitForTimeout(ms);
  const actorList = studio.getByTestId("actor-list");
  const rows = actorList.locator("tbody tr");
  const reloadDashboard = async () => {
    await studio.goto(STUDIO);
    await actorList.or(studio.getByText("No actors found.")).first().waitFor({ timeout: 10_000 });
  };

  // --- 1. Dashboard ---------------------------------------------------------
  await studio.goto(STUDIO);
  await caption(studio, "1. Dashboard: fresh dev server, no actors registered yet");
  await pause(2500);
  await shot(studio, "dashboard-empty");

  const alice = await chatUser(browser, "alice");
  const bob = await chatUser(browser, "bob");
  const carol = await chatUser(browser, "carol");
  const dave = await chatUser(browser, "dave");

  await caption(studio, "1. Dashboard: carol opens room 'standup' and says hello");
  const carolStandup = await joinRoom(carol, "standup");
  await say(carolStandup, "standup starts in 5");
  await pause(1500);
  await reloadDashboard();
  await pause(2000);

  await caption(studio, "1. Dashboard: bob and dave open room 'design-review'");
  const bobDesign = await joinRoom(bob, "design-review");
  await joinRoom(dave, "design-review");
  await say(bobDesign, "mockups are up");
  await pause(1500);
  await reloadDashboard();
  await pause(2000);

  await caption(studio, "1. Dashboard: alice opens room 'lobby' (most recent activity)");
  const aliceLobby = await joinRoom(alice, "lobby");
  await say(aliceLobby, "hi everyone");
  await say(aliceLobby, "welcome to the lobby");
  await pause(1500);
  await reloadDashboard();
  await caption(studio, "1. Dashboard: sorted by recent activity: lobby, design-review, standup");
  await expectOnCamera(
    studio,
    "rows ordered lobby, design-review, standup",
    async () => {
      const ids = await rows.locator("td:nth-child(2)").allInnerTexts();
      if (ids.join(",") !== "lobby,design-review,standup") throw new Error(ids.join(","));
    },
    async () => JSON.stringify(await rows.locator("td:nth-child(2)").allInnerTexts()),
  );
  await pause(2500);
  await shot(studio, "dashboard-sorted");

  await caption(studio, "1. Dashboard: connection counts per actor (lobby 1, design-review 2, standup 1)");
  await expectOnCamera(
    studio,
    "connection counts lobby=1, design-review=2, standup=1",
    async () => {
      const counts = await rows.locator("td:nth-child(4)").allInnerTexts();
      if (counts.join(",") !== "1,2,1") throw new Error(counts.join(","));
    },
    async () => JSON.stringify(await rows.locator("td:nth-child(4)").allInnerTexts()),
  );
  await studio.locator("thead th", { hasText: "Connections" }).hover();
  await pause(2500);
  await shot(studio, "dashboard-connections");

  // Registry touches are debounced 10s per actor, so wait past that before new activity in 'standup'.
  await caption(studio, "1. Dashboard: 11s later carol posts in 'standup', which moves it to the top");
  await pause(11_000);
  await say(carolStandup, "standup is starting now");
  await pause(1000);
  await reloadDashboard();
  await expectOnCamera(
    studio,
    "'standup' first after new activity",
    async () => {
      await rows.first().locator("td:nth-child(2)", { hasText: "standup" }).waitFor({ timeout: 3000 });
    },
    async () => JSON.stringify(await rows.locator("td:nth-child(2)").allInnerTexts()),
  );
  await pause(2500);
  await shot(studio, "dashboard-resorted");

  await caption(studio, "1. Dashboard: type filter (chat-room is the only actor type here)");
  await studio.getByTestId("type-filter").selectOption(ACTOR_TYPE);
  await pause(2500);
  await shot(studio, "dashboard-type-filter");
  await studio.getByTestId("type-filter").selectOption("");
  await pause(1000);

  await caption(studio, "1. Dashboard: search by actor ID ('design')");
  await studio.getByTestId("search-input").pressSequentially("design", { delay: 120 });
  await expectOnCamera(
    studio,
    "only 'design-review' listed",
    async () => {
      await rows.first().locator("td:nth-child(2)", { hasText: "design-review" }).waitFor({ timeout: 3000 });
      const n = await rows.count();
      if (n !== 1) throw new Error(String(n));
    },
    async () => JSON.stringify(await rows.locator("td:nth-child(2)").allInnerTexts()),
  );
  await pause(2500);
  await shot(studio, "dashboard-search");
  await studio.getByTestId("search-input").fill("");
  await pause(1000);

  await caption(studio, "1. Dashboard: manual connect by type + ID (chat-room / lobby)");
  await studio.getByTestId("manual-type").pressSequentially(ACTOR_TYPE, { delay: 80 });
  await studio.getByTestId("manual-id").pressSequentially("lobby", { delay: 80 });
  await pause(1200);
  await shot(studio, "dashboard-manual-connect");
  await studio.getByTestId("manual-connect").click();

  // --- 2. Actor detail: live state ------------------------------------------
  const status = studio.getByTestId("status");
  const statePanel = studio.getByTestId("state-panel");
  await caption(studio, "2. Actor detail: live state JSON tree for chat-room/lobby");
  await expectOnCamera(
    studio,
    "status 'Live' on the lobby detail page",
    () => status.filter({ hasText: "Live" }).waitFor({ timeout: 10_000 }),
    textOf(studio.locator("main")),
  );
  await pause(2500);
  await shot(studio, "detail-state");

  await caption(studio, "2. Actor detail: expand a message node");
  await statePanel.getByRole("button", { name: "{ 4 keys }" }).first().click();
  await pause(2500);
  await shot(studio, "detail-state-expanded");

  await caption(studio, "2. Actor detail: collapse the messages array");
  await statePanel.getByRole("button", { name: "[", exact: true }).first().click();
  await pause(2000);
  await shot(studio, "detail-state-collapsed");

  await caption(studio, "2. Actor detail: bob joins 'lobby' from another browser; onlineUsers updates live");
  const bobLobby = await joinRoom(bob, "lobby");
  await expectOnCamera(
    studio,
    "'bob' in onlineUsers",
    () => statePanel.getByText('"bob"').waitFor({ timeout: 5000 }),
    textOf(statePanel),
  );
  await pause(2500);

  await caption(studio, "2. Actor detail: bob sends a message; messages goes from 2 to 3 items live");
  await say(bobLobby, "hey alice, bob here");
  await expectOnCamera(
    studio,
    "messages collapsed as '[3 items]'",
    () => statePanel.getByRole("button", { name: "[3 items]" }).waitFor({ timeout: 5000 }),
    textOf(statePanel),
  );
  await pause(2000);
  await shot(studio, "detail-state-live");

  await caption(studio, "2. Actor detail: expand messages again to see bob's message");
  await statePanel.getByRole("button", { name: "[3 items]" }).click();
  await pause(800);
  await statePanel.getByRole("button", { name: "{ 4 keys }" }).last().click();
  await expectOnCamera(
    studio,
    "bob's message text in the state tree",
    () => statePanel.getByText("hey alice, bob here").waitFor({ timeout: 3000 }),
    textOf(statePanel),
  );
  await pause(2500);
  await shot(studio, "detail-state-new-message");

  // --- 3. Timeline -------------------------------------------------------------
  const timelinePanel = studio.getByTestId("timeline-panel");
  const timelineRows = timelinePanel.locator("button[data-testid^=timeline-entry-]");
  await caption(studio, "3. Timeline: every mutation, newest first");
  await studio.getByTestId("tab-timeline").click();
  await pause(2500);
  await shot(studio, "timeline");

  await caption(studio, "3. Timeline: alice sends a message; a new entry appears live at the top");
  const beforeCount = await timelineRows.count();
  await say(aliceLobby, "nice to see you bob");
  await expectOnCamera(
    studio,
    "a new top entry 'alice sent SEND_MESSAGE'",
    async () => {
      await timelineRows.first().filter({ hasText: "alice sent SEND_MESSAGE" }).waitFor({ timeout: 5000 });
      const after = await timelineRows.count();
      if (after !== beforeCount + 1) throw new Error(`${beforeCount} -> ${after}`);
    },
    async () => `${await timelineRows.count()} entries, top: ${await textOf(timelineRows.first())()}`,
  );
  await pause(2000);

  await caption(studio, "3. Timeline: expand it: green + for the added message, then the payload");
  await timelineRows.first().click();
  await expectOnCamera(
    studio,
    "an added (+) diff row and the SEND_MESSAGE payload",
    async () => {
      await timelinePanel.locator("[data-diff-row]", { hasText: "+" }).first().waitFor({ timeout: 3000 });
      await timelinePanel.getByText('"nice to see you bob"').first().waitFor({ timeout: 3000 });
    },
    textOf(timelinePanel.locator("div.border").first()),
  );
  await pause(3000);
  await shot(studio, "timeline-expanded-message");
  await timelineRows.first().click();
  await pause(800);

  await caption(studio, "3. Timeline: carol joins 'lobby': a connect lifecycle entry");
  const carolLobby = await joinRoom(carol, "lobby");
  await expectOnCamera(
    studio,
    "a top entry 'carol connected (user)'",
    () => timelineRows.first().filter({ hasText: "carol connected (user)" }).waitFor({ timeout: 5000 }),
    textOf(timelineRows.first()),
  );
  await pause(2500);
  await shot(studio, "timeline-connect");

  await caption(studio, "3. Timeline: bob closes his lobby tab: a disconnect lifecycle entry");
  await bobLobby.close();
  await expectOnCamera(
    studio,
    "a top entry 'bob disconnected'",
    () => timelineRows.first().filter({ hasText: "bob disconnected" }).waitFor({ timeout: 8000 }),
    textOf(timelineRows.first()),
  );
  await pause(2000);

  await caption(studio, '3. Timeline: its diff: one red removed row, onlineUsers[1] "bob"');
  await timelineRows.first().click();
  const openEntry = timelinePanel.locator("div.border").first();
  await expectOnCamera(
    studio,
    'exactly one diff row: onlineUsers[1] removed "bob"',
    async () => {
      await openEntry
        .locator('[data-diff-row][data-diff-type="removed"]', { hasText: "onlineUsers[1]" })
        .filter({ hasText: '"bob"' })
        .waitFor({ timeout: 3000 });
      const rowCount = await openEntry.locator("[data-diff-row]").count();
      if (rowCount !== 1) throw new Error(`${rowCount} rows`);
    },
    textOf(openEntry),
  );
  await pause(3000);
  await shot(studio, "timeline-diff-removed");
  await timelineRows.first().click();
  await pause(800);

  // chat.ts keeps the last 50 messages, so once 'lobby' is full each new message drops the
  // oldest: same-length arrays of objects are diffed by index, so every slot shows as changed.
  await caption(studio, "3. Timeline: carol fills 'lobby' to its 50-message cap (chat.ts keeps the last 50)");
  for (let i = 1; i <= 50; i++) await say(carolLobby, `filler ${String(i).padStart(2, "0")} of 50`);
  await caption(studio, "3. Timeline: one more message at the cap shifts every slot: changed rows, in yellow");
  await say(carolLobby, "one past the cap");
  await expectOnCamera(
    studio,
    "a top entry 'carol sent SEND_MESSAGE'",
    () => timelineRows.first().filter({ hasText: "carol sent SEND_MESSAGE" }).waitFor({ timeout: 8000 }),
    textOf(timelineRows.first()),
  );
  await timelineRows.first().click();
  const changedValue = openEntry.locator('[data-diff-row][data-diff-type="changed"]').first().locator("span").last();
  const changedColour = () => changedValue.evaluate((el) => getComputedStyle(el).color);
  // Spec (docs/specs/actor-kit-studio.md, Timeline panel): added=green, removed=red, changed=yellow.
  await expectOnCamera(
    studio,
    "yellow 'changed' diff rows (spec: added=green, removed=red, changed=yellow)",
    async () => {
      await changedValue.waitFor({ timeout: 3000 });
      const isAmber = await changedValue.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--color-amber-300)";
        document.body.append(probe);
        const amber = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(el).color === amber;
      });
      if (!isAmber) throw new Error("not amber");
    },
    async () => `changed value colour ${await changedColour().catch(() => "unknown")}`,
  );
  await pause(3000);
  await shot(studio, "timeline-diff-changed");
  await timelineRows.first().click();
  await pause(800);

  // --- 4. Connections ------------------------------------------------------------
  const connPanel = studio.getByTestId("connections-panel");
  const connRows = connPanel.locator("tbody tr");
  const connTab = studio.getByTestId("tab-connections");
  await caption(studio, "4. Connections: one row per socket (alice, carol)");
  await connTab.click();
  await expectOnCamera(
    studio,
    "2 connection rows",
    async () => {
      await connRows.nth(1).waitFor({ timeout: 3000 });
      if ((await connRows.count()) !== 2) throw new Error("count");
    },
    async () => JSON.stringify(await connRows.locator("td:first-child").allInnerTexts()),
  );
  await pause(2500);
  await shot(studio, "connections");

  await caption(studio, "4. Connections: alice opens a second tab; a second alice row appears live");
  const aliceLobby2 = await joinRoom(alice, "lobby");
  await expectOnCamera(
    studio,
    "3 rows, 2 of them alice, tab count 'Connections (3)'",
    async () => {
      await connRows.nth(2).waitFor({ timeout: 5000 });
      await connTab.filter({ hasText: "(3)" }).waitFor({ timeout: 3000 });
    },
    async () => JSON.stringify(await connRows.locator("td:first-child").allInnerTexts()),
  );
  await pause(2500);

  await caption(studio, "4. Connections: dave opens a third tab in 'lobby'");
  const daveLobby = await joinRoom(dave, "lobby");
  await expectOnCamera(
    studio,
    "4 rows, tab count 'Connections (4)'",
    async () => {
      await connRows.nth(3).waitFor({ timeout: 5000 });
      await connTab.filter({ hasText: "(4)" }).waitFor({ timeout: 3000 });
    },
    async () => JSON.stringify(await connRows.locator("td:first-child").allInnerTexts()),
  );
  await pause(2500);
  await shot(studio, "connections-four");

  const aliceTimes = async () =>
    (
      await connRows
        .filter({ hasText: "alice" })
        .locator("td:nth-child(4)")
        .evaluateAll((tds) => tds.map((td) => td.getAttribute("title") ?? ""))
    ).sort();
  const aliceBefore = await aliceTimes();
  await caption(studio, "4. Connections: alice closes her second tab; only that row drops");
  await aliceLobby2.close();
  await expectOnCamera(
    studio,
    "3 rows left, alice's first-tab row (oldest) still listed",
    async () => {
      await connRows.nth(3).waitFor({ state: "detached", timeout: 8000 });
      const after = await aliceTimes();
      if (after.length !== 1 || after[0] !== aliceBefore[0]) throw new Error(JSON.stringify(after));
    },
    async () =>
      `${JSON.stringify(await connRows.locator("td:first-child").allInnerTexts())}, alice connectedAt ${JSON.stringify(await aliceTimes())}`,
  );
  await pause(3000);
  await shot(studio, "connections-tab-closed");

  // Lifecycle hooks fire per socket; chat.ts only drops a user when their last socket closes.
  await caption(studio, "4. Presence: alice still has a tab open, so she stays online");
  await studio.getByTestId("tab-state").click();
  // Collapse the 50 messages so onlineUsers is on screen.
  await statePanel.getByRole("button", { name: "[", exact: true }).first().click();
  await expectOnCamera(
    studio,
    "'alice' still in onlineUsers and carol's chat header still '3 online' (alice, carol, dave)",
    async () => {
      await carolLobby.locator("#info", { hasText: "3 online" }).waitFor({ timeout: 5000 });
      await statePanel.getByText('"alice"').first().waitFor({ timeout: 3000 });
    },
    async () => `carol's header ${await textOf(carolLobby.locator("#info"))()}`,
  );
  await pause(3000);
  await shot(studio, "presence-alice-still-online");
  await connTab.click();
  await pause(800);

  // --- 5. Outbox and links ---------------------------------------------------------
  // chat.ts declares no `services` and no `links`, so both panels are empty for real.
  await caption(studio, "5. Outbox: empty — chat-room declares no services (no ctx.execute)");
  await studio.getByTestId("tab-outbox").click();
  await expectOnCamera(
    studio,
    "'No executions.'",
    () => studio.getByTestId("outbox-panel").getByText("No executions.").waitFor({ timeout: 3000 }),
    textOf(studio.getByTestId("outbox-panel")),
  );
  await pause(3000);
  await shot(studio, "outbox-empty");

  await caption(studio, "5. Links: empty — chat-room declares no links and has no subscribers");
  await studio.getByTestId("tab-links").click();
  await expectOnCamera(
    studio,
    "'No active links.' and 'No subscribers.'",
    async () => {
      await studio.getByTestId("links-panel").getByText("No active links.").waitFor({ timeout: 3000 });
      await studio.getByTestId("links-panel").getByText("No subscribers.").waitFor({ timeout: 3000 });
    },
    textOf(studio.getByTestId("links-panel")),
  );
  await pause(3000);
  await shot(studio, "links-empty");

  // --- 6a. Resilience: dev server restart ------------------------------------------------
  await studio.getByTestId("tab-timeline").click();
  await caption(studio, "6a. Resilience: stopping the wrangler dev server mid-session");
  await pause(1500);
  // Watch the chat pages reconnect too, so a message can be sent once the server is back.
  const aliceReconnected = waitForLiveSocket(aliceLobby, 90_000).then(
    () => true,
    () => false,
  );
  await stopServer();
  await expectOnCamera(
    studio,
    "status 'Reconnecting...' while the server is down",
    () => status.filter({ hasText: /Reconnecting|Polling/ }).waitFor({ timeout: 10_000 }),
    textOf(studio.locator("main p").first()),
  );
  await caption(studio, "6a. Resilience: server down, Studio shows Reconnecting...");
  await pause(3000);
  await shot(studio, "restart-reconnecting");

  await caption(studio, "6a. Resilience: starting the wrangler dev server again");
  startServer();
  await waitForServer();
  await expectOnCamera(
    studio,
    "status back to 'Live' within 30s of the server answering",
    () => status.filter({ hasText: "Live" }).waitFor({ timeout: 30_000 }),
    textOf(studio.locator("main p").first()),
  );
  await caption(studio, "6a. Resilience: Studio is Live again");
  await pause(2500);
  await shot(studio, "restart-live");

  await caption(studio, "6a. Resilience: alice's chat tab reconnects and sends a message");
  let aliceAfter = aliceLobby;
  if (!(await aliceReconnected)) {
    // Not a Studio feature, but report it: the example's client did not reconnect on its own.
    findings.push({
      step: currentStep,
      expected: "alice's chat-room client reconnects on its own after the restart",
      observed: "no live WebSocket within 90s; the walkthrough reloaded alice's tab",
      screenshot: await shot(studio, "restart-chat-client"),
    });
    aliceAfter = await joinRoom(alice, "lobby");
  }
  await say(aliceAfter, "back after the restart");
  await expectOnCamera(
    studio,
    "a top timeline entry 'alice sent SEND_MESSAGE' after the restart",
    () => timelineRows.first().filter({ hasText: "alice sent SEND_MESSAGE" }).waitFor({ timeout: 8000 }),
    textOf(timelineRows.first()),
  );
  await timelineRows.first().click();
  await expectOnCamera(
    studio,
    "the post-restart message in the expanded entry",
    () => timelinePanel.getByText('"back after the restart"').first().waitFor({ timeout: 3000 }),
    textOf(timelinePanel.locator("div.border").first()),
  );
  await pause(3000);
  await shot(studio, "restart-update-arrives");
  await timelineRows.first().click();

  await caption(studio, "6a. Resilience: connections after the restart (sockets that reconnected)");
  await connTab.click();
  await pause(3000);
  await shot(studio, "restart-connections");

  // --- 6b. Resilience: nonexistent actor ---------------------------------------------------
  await caption(studio, `6b. Resilience: manual connect to a nonexistent actor (${GHOST_ID})`);
  await studio.getByRole("link", { name: "← Dashboard" }).click();
  await studio.getByTestId("manual-type").waitFor();
  await studio.getByTestId("manual-type").pressSequentially(ACTOR_TYPE, { delay: 60 });
  await studio.getByTestId("manual-id").pressSequentially(GHOST_ID, { delay: 60 });
  await pause(1000);
  await studio.getByTestId("manual-connect").click();
  await expectOnCamera(
    studio,
    "'This actor doesn't exist yet. Waiting for it to be created...'",
    () => studio.getByTestId("not-found").waitFor({ timeout: 10_000 }),
    textOf(studio.locator("main")),
  );
  await caption(studio, "6b. Resilience: not found, Studio waits (and keeps retrying) for it to be created");
  await pause(4000);
  await shot(studio, "ghost-not-found");

  await caption(studio, `6b. Resilience: back on the dashboard, search '${GHOST_ID}': no phantom row`);
  await studio.getByRole("link", { name: "Back to dashboard" }).click();
  await studio.getByTestId("search-input").waitFor();
  await studio.getByTestId("search-input").pressSequentially(GHOST_ID, { delay: 80 });
  await expectOnCamera(
    studio,
    `'No actors found.' for '${GHOST_ID}'`,
    () => studio.getByText("No actors found.").waitFor({ timeout: 5000 }),
    textOf(studio.locator("main")),
  );
  await pause(3000);
  await shot(studio, "ghost-no-phantom");

  await studio.getByTestId("search-input").fill("");
  await caption(studio, "Done: the three real rooms are still listed, nothing else");
  await rows.first().waitFor({ timeout: 5000 });
  await pause(3000);
  await shot(studio, "done");

  await Promise.all([alice.close(), bob.close(), carol.close(), dave.close()]);
  void carolLobby;
  void daveLobby;
}

function convertToMp4(): boolean {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.status !== 0) return false;
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", WEBM, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", MP4],
    { stdio: "inherit" },
  );
  return res.status === 0;
}

async function main(): Promise<void> {
  if (!existsSync(join(CHAT_DIR, ".output/server/wrangler.json"))) {
    throw new Error("examples/chat-room is not built: run `pnpm build && pnpm --filter actor-kit-chat-example build`");
  }
  rmSync(join(OUT_DIR, ".state"), { recursive: true, force: true });
  rmSync(SHOTS_DIR, { recursive: true, force: true });
  rmSync(LOG_FILE, { force: true });
  for (const dir of [STATE_DIR, SHOTS_DIR, VIDEO_TMP]) mkdirSync(dir, { recursive: true });

  const onSignal = () => {
    void stopServer().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  console.log(`Starting chat-room on ${BASE} (log: ${LOG_FILE})`);
  startServer();
  let browser: Browser | null = null;
  try {
    await waitForServer();
    browser = await chromium.launch({ slowMo: 300 });
    const studioContext = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: VIDEO_TMP, size: SIZE },
    });
    await studioContext.addInitScript(installCaptionBar);
    const studio = await studioContext.newPage();
    try {
      await walkthrough(browser, studio);
    } catch (err) {
      const file = await shot(studio, "aborted").catch(() => "none");
      findings.push({
        step: currentStep,
        expected: "walkthrough completes",
        observed: `aborted: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        screenshot: file,
      });
    }
    const video = studio.video();
    await studioContext.close();
    if (video !== null) {
      rmSync(WEBM, { force: true });
      renameSync(await video.path(), WEBM);
    }
  } finally {
    await browser?.close();
    await stopServer();
  }

  for (const f of readdirSync(VIDEO_TMP)) rmSync(join(VIDEO_TMP, f), { force: true });
  const mp4 = convertToMp4();
  writeFileSync(join(SHOTS_DIR, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);

  console.log(`\nVideo: ${WEBM}${mp4 ? `\n       ${MP4}` : " (ffmpeg not found, no mp4)"}`);
  console.log(`Shots: ${SHOTS_DIR}`);
  if (findings.length === 0) {
    console.log("Findings: none, every step behaved as expected.");
  } else {
    console.log(`Findings (${findings.length}):`);
    for (const f of findings) console.log(`- [${f.step}] expected ${f.expected}; saw ${f.observed} (${f.screenshot})`);
  }
}

await main();
