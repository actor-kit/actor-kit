import { defineConfig } from "vitest/config";

/**
 * Vitest config for Stryker mutation testing.
 * Includes both unit and integration tests so mutants are tested
 * against the full test suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
  },
});
