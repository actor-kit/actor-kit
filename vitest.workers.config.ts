import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workers/wrangler.toml" },
    }),
  ],
  // xstate-migrate ships CJS with `export` — need to optimize it for Workers
  optimizeDeps: {
    include: ["xstate-migrate"],
  },
  ssr: {
    optimizeDeps: {
      include: ["xstate-migrate"],
    },
  },
  test: {
    include: ["tests/workers/**/*.test.ts"],
    testTimeout: 15000,
  },
});
