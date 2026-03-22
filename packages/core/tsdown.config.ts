import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      "zod",
      /^fast-json-patch/,
      /^jose/,
      /^cloudflare:/,
    ],
  },
});
