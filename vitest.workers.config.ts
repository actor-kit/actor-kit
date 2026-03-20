import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/integration/workers/wrangler.toml" },
    }),
  ],
  resolve: {
    alias: {
      "@actor-kit/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@actor-kit/worker": path.resolve(__dirname, "packages/worker/src/index.ts"),
      "@actor-kit/server": path.resolve(__dirname, "packages/server/src/index.ts"),
      "@actor-kit/browser": path.resolve(__dirname, "packages/browser/src/index.ts"),
    },
  },
  test: {
    include: ["tests/integration/workers/**/*.test.ts"],
    testTimeout: 15000,
  },
});
