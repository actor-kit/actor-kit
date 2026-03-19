import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "packages/worker/tests/__mocks__/cloudflare-workers.ts"),
      "@actor-kit/types": path.resolve(__dirname, "packages/types/src/index.ts"),
      "@actor-kit/browser": path.resolve(__dirname, "packages/browser/src/index.ts"),
      "@actor-kit/worker": path.resolve(__dirname, "packages/worker/src/index.ts"),
      "@actor-kit/server": path.resolve(__dirname, "packages/server/src/index.ts"),
      "@actor-kit/test": path.resolve(__dirname, "packages/test/src/index.ts"),
      "@actor-kit/react": path.resolve(__dirname, "packages/react/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/integration/**/*.test.ts",
      "!tests/integration/workers/**",
    ],
    testTimeout: 15000,
  },
});
