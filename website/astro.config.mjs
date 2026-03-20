import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://actorkit.dev",
  integrations: [
    starlight({
      title: "Actor Kit",
      description:
        "Type-safe state machines on Cloudflare Durable Objects with real-time client sync.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/actor-kit/actor-kit",
        },
      ],
      plugins: [starlightLlmsTxt()],
      editLink: {
        baseUrl:
          "https://github.com/actor-kit/actor-kit/edit/main/website/src/content/docs/",
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { slug: "getting-started/overview" },
            { slug: "getting-started/installation" },
            { slug: "getting-started/quick-start" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/how-it-works" },
            { slug: "concepts/public-private-context" },
            { slug: "concepts/caller-types" },
            { slug: "concepts/sync-protocol" },
            { slug: "concepts/persistence" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/nextjs" },
            { slug: "guides/testing" },
            { slug: "guides/storybook" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { slug: "api/types" },
            { slug: "api/worker" },
            { slug: "api/browser" },
            { slug: "api/react" },
            { slug: "api/server" },
            { slug: "api/test" },
            { slug: "api/storybook" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { slug: "architecture/system-design" },
            { slug: "architecture/decisions" },
          ],
        },
      ],
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
