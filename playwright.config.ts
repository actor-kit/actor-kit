import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "examples",
  testMatch: ["**/*.e2e.ts", "**/*.spec.ts"],
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
    {
      name: "chat-room",
      testMatch: "chat-room/**/*.e2e.ts",
      use: { baseURL: "http://localhost:8801" },
    },
    {
      name: "auction",
      testMatch: "auction/**/*.e2e.ts",
      use: { baseURL: "http://localhost:8802" },
    },
    {
      name: "tanstack-start-counter",
      testMatch: "tanstack-start-counter/**/*.spec.ts",
      use: { baseURL: "http://localhost:8803" },
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
    {
      command: "cd examples/chat-room && npx wrangler dev --port 8801",
      port: 8801,
      reuseExistingServer: true,
      timeout: 15000,
    },
    {
      command: "cd examples/auction && npx wrangler dev --port 8802",
      port: 8802,
      reuseExistingServer: true,
      timeout: 15000,
    },
    {
      command:
        "cd examples/tanstack-start-counter && pnpm build && npx wrangler dev -c .output/server/wrangler.json --port 8803 --inspector-port 0",
      port: 8803,
      reuseExistingServer: true,
      timeout: 30000,
    },
  ],
});
