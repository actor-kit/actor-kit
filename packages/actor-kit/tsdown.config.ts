import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "core/index": "src/core/index.ts",
    "client/index": "src/client/index.ts",
    "react/index": "src/react/index.ts",
    "test/index": "src/test/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  hash: false,
  external: ["cloudflare:workers", "react", "zod", "jose", "immer"],
});
