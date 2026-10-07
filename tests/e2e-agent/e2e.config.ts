/**
 * tester-army/e2e config for live, multi-browser Studio scenarios.
 *
 * Model-free: tests use locators and assertions only, no `agent.*` steps, so no
 * `agents` block and no model key.
 *
 * Two targets, each started by the runner on its own port (outside the
 * 8799-8810 range the root Playwright config reuses):
 * - `studio`    → tests/e2e-studio worker (Counter + Studio)  on :8830
 * - `chat-room` → examples/chat-room (TanStack Start + Studio) on :8831
 *   (`pnpm test:e2e-agent` builds chat-room first; wrangler serves the build)
 *
 * Run one target's suite with its folder: `e2e run --target studio tests/studio`.
 */

import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";
import { CHAT_ROOM_PORT, STUDIO_PORT } from "./tests/support/ports";

const wranglerEnv = { WRANGLER_SEND_METRICS: "false" };

export default {
  tests: ["tests/**/*.e2e.ts"],
  workers: 1,
  timeout: 90_000,
  targets: [
    {
      name: "studio",
      engine: web(),
      app: {
        url: `http://localhost:${STUDIO_PORT}`,
        command: {
          executable: "pnpm",
          args: [
            "exec",
            "wrangler",
            "dev",
            "--persist-to",
            ".wrangler/state-e2e-agent",
            "--port",
            String(STUDIO_PORT),
            "--inspector-port",
            "0",
          ],
          cwd: "../e2e-studio",
          env: wranglerEnv,
          startupTimeout: 60_000,
          log: ".e2e/logs/studio.log",
        },
      },
    },
    {
      name: "chat-room",
      engine: web(),
      app: {
        url: `http://localhost:${CHAT_ROOM_PORT}`,
        command: {
          executable: "pnpm",
          args: [
            "exec",
            "wrangler",
            "dev",
            "-c",
            ".output/server/wrangler.json",
            "--persist-to",
            ".wrangler/state-e2e-agent",
            "--port",
            String(CHAT_ROOM_PORT),
            "--inspector-port",
            "0",
          ],
          cwd: "../../examples/chat-room",
          env: wranglerEnv,
          startupTimeout: 60_000,
          log: ".e2e/logs/chat-room.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
