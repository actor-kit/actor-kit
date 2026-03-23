import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        isolatedStorage: true,
      },
    },
    // Exclude websocket tests — they need non-isolated storage
    // due to vitest-pool-workers SQLite limitation
    exclude: ["websocket.test.ts", "binary-views.test.ts", "auth.test.ts"],
  },
});
