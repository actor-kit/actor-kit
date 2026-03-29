import { defineConfig } from "@playwright/test";

// When DEPLOYED_*_URL env vars are set, tests run against deployed workers.
// When absent, tests run against local wrangler dev servers.
const counterUrl =
  process.env["DEPLOYED_COUNTER_URL"] ?? "http://localhost:8799";
const todoListUrl =
  process.env["DEPLOYED_TODO_LIST_URL"] ?? "http://localhost:8800";
const chatRoomUrl =
  process.env["DEPLOYED_CHAT_ROOM_URL"] ?? "http://localhost:8801";
const auctionUrl =
  process.env["DEPLOYED_AUCTION_URL"] ?? "http://localhost:8802";
const tanstackStartCounterUrl =
  process.env["DEPLOYED_TANSTACK_START_COUNTER_URL"] ??
  "http://localhost:8803";

const isDeployed =
  !!process.env["DEPLOYED_COUNTER_URL"] ||
  !!process.env["DEPLOYED_TODO_LIST_URL"] ||
  !!process.env["DEPLOYED_CHAT_ROOM_URL"] ||
  !!process.env["DEPLOYED_AUCTION_URL"] ||
  !!process.env["DEPLOYED_TANSTACK_START_COUNTER_URL"];

export default defineConfig({
  testDir: "examples",
  testMatch: ["**/*.e2e.ts", "**/*.spec.ts"],
  timeout: isDeployed ? 60000 : 30000,
  retries: isDeployed ? 2 : 1,
  projects: [
    {
      name: "counter",
      testMatch: "counter/**/*.e2e.ts",
      use: { baseURL: counterUrl },
    },
    {
      name: "todo-list",
      testMatch: "todo-list/**/*.e2e.ts",
      use: { baseURL: todoListUrl },
    },
    {
      name: "chat-room",
      testMatch: "chat-room/**/*.e2e.ts",
      use: { baseURL: chatRoomUrl },
    },
    {
      name: "auction",
      testMatch: "auction/**/*.e2e.ts",
      use: { baseURL: auctionUrl },
    },
    {
      name: "tanstack-start-counter",
      testMatch: "tanstack-start-counter/**/*.spec.ts",
      use: { baseURL: tanstackStartCounterUrl },
    },
  ],
  // Only start local servers when not running against deployed workers
  ...(isDeployed
    ? {}
    : {
        webServer: [
          {
            command: "cd examples/counter && npx wrangler dev --port 8799",
            port: 8799,
            reuseExistingServer: true,
            timeout: 30000,
          },
          {
            command:
              "cd examples/todo-list && npx wrangler dev --port 8800",
            port: 8800,
            reuseExistingServer: true,
            timeout: 30000,
          },
          {
            command:
              "cd examples/chat-room && npx wrangler dev --port 8801",
            port: 8801,
            reuseExistingServer: true,
            timeout: 30000,
          },
          {
            command:
              "cd examples/auction && npx wrangler dev --port 8802",
            port: 8802,
            reuseExistingServer: true,
            timeout: 30000,
          },
          {
            command:
              "cd examples/tanstack-start-counter && pnpm build && npx wrangler dev -c .output/server/wrangler.json --port 8803 --inspector-port 0",
            port: 8803,
            reuseExistingServer: true,
            timeout: 60000,
          },
        ],
      }),
});
