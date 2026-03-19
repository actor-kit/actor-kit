import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "tests/__mocks__/cloudflare-workers.ts"),
      "@actor-kit/worker": path.resolve(__dirname, "src/index.ts"),
      "@actor-kit/server": path.resolve(__dirname, "../server/src/index.ts"),
      "@actor-kit/types": path.resolve(__dirname, "../types/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
