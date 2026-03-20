import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      /^@actor-kit\//,
      "zod",
      /^fast-json-patch/,
      /^immer/,
      /^jose/,
      /^xstate/,
      /^react/,
      /^@storybook/,
      /^cloudflare:/,
    ],
  },
});
