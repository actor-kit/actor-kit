import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      /^@actor-kit\//,
      /^xstate/,
      /^zod/,
    ],
  },
});
