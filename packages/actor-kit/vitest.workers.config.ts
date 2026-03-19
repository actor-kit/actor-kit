import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workers/wrangler.toml" },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.test.ts"],
    testTimeout: 15000,
  },
});
