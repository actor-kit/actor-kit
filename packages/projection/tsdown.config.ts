import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: "esm",
  // Keep .js/.d.ts output (tsdown >=0.15 defaults to .mjs) — package.json exports point at .js.
  fixedExtension: false,
  dts: true,
  clean: true,
  hash: false,
  external: ["zod", "@actor-kit/core"],
});
