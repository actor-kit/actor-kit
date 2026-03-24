import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "examples",
  testMatch: "**/*.e2e.ts",
  timeout: 30000,
  projects: [
    {
      name: "counter",
      testMatch: "counter/**/*.e2e.ts",
      use: { baseURL: "http://localhost:8799" },
    },
    {
      name: "todo-list",
      testMatch: "todo-list/**/*.e2e.ts",
      use: { baseURL: "http://localhost:8800" },
    },
  ],
  webServer: [
    {
      command: "cd examples/counter && npx wrangler dev --port 8799",
      port: 8799,
      reuseExistingServer: true,
      timeout: 15000,
    },
    {
      command: "cd examples/todo-list && npx wrangler dev --port 8800",
      port: 8800,
      reuseExistingServer: true,
      timeout: 15000,
    },
  ],
});
