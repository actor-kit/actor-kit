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
          label: "Examples",
          items: [
            { slug: "examples/counter" },
            { slug: "examples/todo-list" },
            { slug: "examples/chat-room" },
            { slug: "examples/auction" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/actors-and-state" },
            { slug: "concepts/authentication" },
            { slug: "concepts/roles-and-authorization" },
            { slug: "concepts/messages-and-guards" },
            { slug: "concepts/views" },
            { slug: "concepts/binary-sync" },
            { slug: "concepts/side-effects" },
            { slug: "concepts/timers" },
            { slug: "concepts/domain-events" },
            { slug: "concepts/states" },
            { slug: "concepts/testing" },
          ],
        },
        {
          label: "Recipes",
          items: [
            { slug: "recipes/actor-to-actor" },
            { slug: "recipes/scaling-with-relays" },
            { slug: "recipes/testing-side-effects" },
            { slug: "recipes/storybook" },
          ],
        },
        {
          label: "Studio",
          items: [
            { slug: "studio/overview" },
            { slug: "studio/setup" },
          ],
        },
        { slug: "faq", label: "FAQ" },
        {
          label: "Error codes",
          items: [{ autogenerate: { directory: "errors", collapsed: true } }],
        },
        {
          label: "API Reference",
          items: [
            { slug: "api/core", label: "core & worker" },
            { slug: "api/client", label: "client" },
            { slug: "api/react", label: "react" },
            { slug: "api/test", label: "test" },
            { slug: "api/storybook", label: "storybook" },
            { slug: "api/studio", label: "studio" },
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
