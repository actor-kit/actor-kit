// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://actorkit.dev",
  integrations: [
    starlight({
      title: "Actor Kit",
      logo: {
        dark: "./src/assets/logo.svg",
        light: "./src/assets/logo-light.svg",
        replacesTitle: false,
      },
      description:
        "Actors on the Edge — real-time state sync with Cloudflare Durable Objects.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/actor-kit/actor-kit",
        },
      ],
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
          label: "Guides",
          items: [
            { slug: "guides/counter" },
            { slug: "guides/todo-list" },
            { slug: "guides/chat-room" },
            { slug: "guides/auction" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/actors-and-state" },
            { slug: "concepts/roles-and-authorization" },
            { slug: "concepts/messages-and-guards" },
            { slug: "concepts/views" },
            { slug: "concepts/side-effects" },
            { slug: "concepts/timers" },
            { slug: "concepts/testing" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { slug: "api/core" },
            { slug: "api/client" },
            { slug: "api/react" },
            { slug: "api/test" },
          ],
        },
      ],
      components: {
        PageTitle: "./src/overrides/PageTitle.astro",
        Header: "./src/overrides/Header.astro",
      },
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
