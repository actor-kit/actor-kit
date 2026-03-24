import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "examples",
  testMatch: "**/*.e2e.ts",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:8799",
  },
  webServer: {
    command: "cd examples/counter && npx wrangler dev --port 8799",
    port: 8799,
    reuseExistingServer: true,
    timeout: 15000,
  },
});
