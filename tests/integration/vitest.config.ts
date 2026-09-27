// Pinned to Vitest 4: @cloudflare/vitest-pool-workers (0.22) supports vitest ^4.1 only.
// Unit tests at the repo root run on Vitest 5.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
});
