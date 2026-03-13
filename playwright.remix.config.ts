import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: /remix\.spec\.ts/,
  use: {
    ...base.use,
    baseURL: "http://localhost:8787",
  },
  webServer: {
    command: "npm --prefix examples/remix-actorkit-todo run dev",
    url: "http://localhost:8787",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
