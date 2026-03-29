import { defineNitroConfig } from "nitro/config";

export default defineNitroConfig({
  compatibilityDate: "2024-09-25",
  preset: "cloudflare_module",
  scanDirs: ["./server"],
  cloudflare: {
    deployConfig: true,
    nodeCompat: true,
  },
});
