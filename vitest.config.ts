import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      // Resolve workspace packages to source for unit tests.
      // Order matters: subpath exports must come before their parent.
      "@actor-kit/worker/testing": resolve(__dirname, "packages/worker/src/testing.ts"),
      "@actor-kit/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@actor-kit/client": resolve(__dirname, "packages/client/src/index.ts"),
      "@actor-kit/react": resolve(__dirname, "packages/react/src/index.ts"),
      "@actor-kit/test": resolve(__dirname, "packages/test/src/index.ts"),
    },
  },
});
