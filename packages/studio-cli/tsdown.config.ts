import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    bin: "src/bin.ts",
    "mcp-bin": "src/mcp-bin.ts",
  },
  format: "esm",
  platform: "node",
  fixedExtension: false,
  dts: true,
  clean: true,
  hash: false,
  external: ["zod", "@modelcontextprotocol/sdk"],
});
