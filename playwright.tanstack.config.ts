import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: /tanstack-start\.spec\.ts/,
  use: {
    ...base.use,
    baseURL: "http://localhost:3002",
  },
  webServer: [
    {
      command: "npm --prefix examples/tanstack-start-actorkit-todo run dev:e2e",
      url: "http://localhost:3002",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: "npm --prefix examples/tanstack-start-actorkit-todo run dev:api",
      url: "http://localhost:8790",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
