import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@actor-kit/types": path.resolve(__dirname, "../types/src/index.ts"),
      "@actor-kit/browser": path.resolve(__dirname, "../browser/src/index.ts"),
      "@actor-kit/worker": path.resolve(__dirname, "../worker/src/index.ts"),
      "@actor-kit/server": path.resolve(__dirname, "../server/src/index.ts"),
      "@actor-kit/test": path.resolve(__dirname, "../test/src/index.ts"),
      "@actor-kit/react": path.resolve(__dirname, "../react/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
