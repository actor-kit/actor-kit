import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3002",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev:e2e",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://localhost:3002/health",
  },
});
