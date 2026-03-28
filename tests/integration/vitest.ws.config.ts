import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        isolatedStorage: false, // WebSocket tests can't use isolated storage with SQLite DOs
      },
    },
    include: [
      "websocket.test.ts",
      "binary-views.test.ts",
      "auth.test.ts",
      "header-auth.test.ts",
      "error-feedback.test.ts",
      "delta-sync.test.ts",
      "tick.test.ts",
      "reconnect.test.ts",
      "views.test.ts",
      "origin-validation.test.ts",
    ],
  },
});
