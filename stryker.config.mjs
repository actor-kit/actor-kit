/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  plugins: [
    "@stryker-mutator/vitest-runner",
  ],
  mutate: [
    "src/createAccessToken.ts",
    "src/createActorFetch.ts",
    "src/createActorKitClient.ts",
  ],
  testRunner: "vitest",
  checkers: [],
  coverageAnalysis: "off",
  reporters: ["clear-text", "progress", "json", "html"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  concurrency: 1,
  timeoutMS: 10_000,
  timeoutFactor: 1.5,
};

export default config;
