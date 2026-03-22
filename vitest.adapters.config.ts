import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/integration/adapters/wrangler.toml" },
    }),
  ],
  test: {
    include: ["tests/integration/adapters/**/*.test.ts"],
    testTimeout: 15000,
  },
});
