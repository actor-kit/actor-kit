import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: /nextjs\.spec\.ts/,
  use: {
    ...base.use,
    baseURL: "http://localhost:3001",
  },
  webServer: [
    {
      command: "npm --prefix examples/nextjs-actorkit-todo run dev:e2e",
      url: "http://localhost:3001",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: "npm --prefix examples/nextjs-actorkit-todo run dev-api",
      url: "http://localhost:8788",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
