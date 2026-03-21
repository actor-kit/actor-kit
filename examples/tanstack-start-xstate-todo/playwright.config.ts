import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3002";
const useLocalServer = process.env.PLAYWRIGHT_BASE_URL === undefined;

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  use: {
    baseURL,
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  webServer: useLocalServer
    ? {
        command: "pnpm dev:e2e",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        url: "http://localhost:3002/health",
      }
    : undefined,
});
