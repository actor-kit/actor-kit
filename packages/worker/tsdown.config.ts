import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
    token: "src/token.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  hash: false,
  external: ["@actor-kit/core", "zod", "jose", "cloudflare:workers"],
});
