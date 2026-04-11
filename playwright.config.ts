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

const isDeployed =
  !!process.env["DEPLOYED_COUNTER_URL"] ||
  !!process.env["DEPLOYED_TODO_LIST_URL"] ||
  !!process.env["DEPLOYED_CHAT_ROOM_URL"] ||
  !!process.env["DEPLOYED_AUCTION_URL"];

export default defineConfig({
  testDir: "examples",
  testMatch: ["**/*.e2e.ts", "**/*.spec.ts"],
  timeout: isDeployed ? 60000 : 30000,
  retries: isDeployed ? 2 : 1,
  projects: [
    {
      name: "counter",
      testMatch: "counter/**/*.spec.ts",
      use: { baseURL: counterUrl },
    },
    {
      name: "todo-list",
      testMatch: "todo-list/**/*.spec.ts",
      use: { baseURL: todoListUrl },
    },
    {
      name: "chat-room",
      testMatch: "chat-room/**/*.spec.ts",
      use: { baseURL: chatRoomUrl },
    },
    {
      name: "auction",
      testMatch: "auction/**/*.spec.ts",
      use: { baseURL: auctionUrl },
    },
  ],
  // Only start local servers when not running against deployed workers.
  // All examples are TanStack Start apps — need build + wrangler dev.
  ...(isDeployed
    ? {}
    : {
        webServer: [
          {
            command:
              "cd examples/counter && pnpm build && npx wrangler dev -c .output/server/wrangler.json --port 8799 --inspector-port 0",
            port: 8799,
            reuseExistingServer: true,
            timeout: 60000,
          },
          {
            command:
              "cd examples/todo-list && pnpm build && npx wrangler dev -c .output/server/wrangler.json --port 8800 --inspector-port 0",
            port: 8800,
            reuseExistingServer: true,
            timeout: 60000,
          },
          {
            command:
              "cd examples/chat-room && pnpm build && npx wrangler dev -c .output/server/wrangler.json --port 8801 --inspector-port 0",
            port: 8801,
            reuseExistingServer: true,
            timeout: 60000,
          },
          {
            command:
              "cd examples/auction && pnpm build && npx wrangler dev -c .output/server/wrangler.json --port 8802 --inspector-port 0",
            port: 8802,
            reuseExistingServer: true,
            timeout: 60000,
          },
        ],
      }),
});
