import { defineConfig } from "@playwright/test";

// When DEPLOYED_*_URL env vars are set, tests run against deployed workers.
// When absent, tests run against local wrangler dev servers.
const studioE2eUrl =
  process.env["STUDIO_E2E_URL"] ?? "http://localhost:8810";
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
  testDir: ".",
  testMatch: ["examples/**/*.e2e.ts", "examples/**/*.spec.ts", "tests/e2e-studio/**/*.spec.ts"],
  timeout: isDeployed ? 60000 : 30000,
  retries: isDeployed ? 2 : 1,
  projects: [
    {
      name: "studio",
      testMatch: "tests/e2e-studio/**/*.spec.ts",
      use: { baseURL: studioE2eUrl },
    },
    {
      name: "counter",
      testMatch: "examples/counter/**/*.spec.ts",
      use: { baseURL: counterUrl },
    },
    {
      name: "todo-list",
      testMatch: "examples/todo-list/**/*.spec.ts",
      use: { baseURL: todoListUrl },
    },
    {
      name: "chat-room",
      testMatch: "examples/chat-room/**/*.spec.ts",
      use: { baseURL: chatRoomUrl },
    },
    {
      name: "auction",
      testMatch: "examples/auction/**/*.spec.ts",
      use: { baseURL: auctionUrl },
    },
  ],
  // Only start local servers when not running against deployed workers.
  // All examples are TanStack Start apps — `pnpm dev` builds then runs wrangler
  // dev with --persist-to outside .output/ (state inside the watched build dir
  // triggers reload loops that drop every WebSocket).
  ...(isDeployed
    ? {}
    : {
        webServer: [
          {
            command:
              "cd tests/e2e-studio && npx wrangler dev --port 8810 --inspector-port 0",
            port: 8810,
            reuseExistingServer: true,
            timeout: 30000,
          },
          {
            command:
              "cd examples/counter && pnpm dev",
            port: 8799,
            reuseExistingServer: true,
            timeout: 60000,
          },
          {
            command:
              "cd examples/todo-list && pnpm dev",
            port: 8800,
            reuseExistingServer: true,
            timeout: 60000,
          },
          {
            command:
              "cd examples/chat-room && pnpm dev",
            port: 8801,
            reuseExistingServer: true,
            timeout: 60000,
          },
          {
            command:
              "cd examples/auction && pnpm dev",
            port: 8802,
            reuseExistingServer: true,
            timeout: 60000,
          },
        ],
      }),
});
