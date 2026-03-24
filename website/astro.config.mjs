// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Actor Kit",
      tagline: "Actors on the Edge",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/actor-kit/actor-kit",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Overview", slug: "getting-started/overview" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Counter", slug: "guides/counter" },
            { label: "Todo List", slug: "guides/todo-list" },
            { label: "Chat Room", slug: "guides/chat-room" },
            { label: "Auction", slug: "guides/auction" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Actors & State", slug: "concepts/actors-and-state" },
            {
              label: "Roles & Authorization",
              slug: "concepts/roles-and-authorization",
            },
            {
              label: "Messages & Guards",
              slug: "concepts/messages-and-guards",
            },
            { label: "Views", slug: "concepts/views" },
            { label: "Side Effects", slug: "concepts/side-effects" },
            { label: "Timers", slug: "concepts/timers" },
            { label: "Testing", slug: "concepts/testing" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { label: "actor-kit", slug: "api/core" },
            { label: "actor-kit/client", slug: "api/client" },
            { label: "actor-kit/react", slug: "api/react" },
            { label: "actor-kit/test", slug: "api/test" },
          ],
        },
      ],
    }),
  ],
});
