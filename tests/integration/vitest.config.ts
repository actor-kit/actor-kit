// Vitest 4: @cloudflare/vitest-pool-workers (0.22) supports vitest ^4.1 only.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  test: {
    // Each worker is a whole workerd runtime. Vitest's default (cores - 1) oversubscribes the CPU:
    // on an 18-core machine, CPU-bound tests (510 sequential DO RPCs in studio.test.ts's ring buffer
    // test) ran ~3.2s instead of ~0.4s and the suite took 13-15s instead of ~9s.
    maxWorkers: "25%",
  },
});
