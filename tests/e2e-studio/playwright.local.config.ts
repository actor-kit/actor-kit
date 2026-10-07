/**
 * Run only the Studio e2e specs against a Studio worker you started yourself,
 * on any port (the root config reuses fixed ports, so parallel worktrees would
 * silently share one server):
 *
 *   cd tests/e2e-studio && pnpm exec wrangler dev --persist-to .wrangler/state --port 8825 --inspector-port 0
 *   STUDIO_E2E_URL=http://localhost:8825 pnpm exec playwright test --config tests/e2e-studio/playwright.local.config.ts
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 0,
  use: { baseURL: process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810" },
});
