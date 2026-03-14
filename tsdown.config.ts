import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    react: "src/react.ts",
    server: "src/server.ts",
    worker: "src/worker.ts",
    test: "src/test.ts",
    storybook: "src/storybook.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      "cloudflare:workers",
      /^@cloudflare\//,
      "react",
      "xstate",
      "xstate-migrate",
      "zod",
      /^@storybook\//,
    ],
  },
  // Workaround: tsdown strips "use client" directives during bundling.
  // We use outputOptions to inject it via rolldown's banner.
  outputOptions: {
    banner: '"use client";',
  },
});
