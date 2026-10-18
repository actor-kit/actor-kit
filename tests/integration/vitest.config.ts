// Vitest 4: @cloudflare/vitest-pool-workers (0.22) supports vitest ^4.1 only.
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerSrc = (file: string) => fileURLToPath(new URL(`../../packages/worker/src/${file}`, import.meta.url));

// Coverage (pnpm crap): run the worker from source so istanbul maps lines to packages/worker/src.
// Plain runs keep testing the built package.
const coverage = process.env.ACTOR_KIT_COVERAGE === "1";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
  resolve: coverage
    ? {
        alias: [
          { find: /^@actor-kit\/worker$/, replacement: workerSrc("index.ts") },
          { find: /^@actor-kit\/worker\/testing$/, replacement: workerSrc("testing.ts") },
          { find: /^@actor-kit\/worker\/token$/, replacement: workerSrc("token.ts") },
        ],
      }
    : {},
  test: {
    // Each worker is a whole workerd runtime. Vitest's default (cores - 1) oversubscribes the CPU:
    // on an 18-core machine, CPU-bound tests (510 sequential DO RPCs in studio.test.ts's ring buffer
    // test) ran ~3.2s instead of ~0.4s and the suite took 13-15s instead of ~9s.
    maxWorkers: "25%",
    // CPU-heavy tests (studio.test.ts's 510 RPCs) went past the 5 s default on a loaded machine.
    testTimeout: 30_000,
    coverage: {
      provider: "istanbul",
      reporter: ["json"],
      allowExternal: true,
      reportsDirectory: "../../coverage/integration",
    },
  },
});
