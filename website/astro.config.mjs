import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import remarkMermaid from "remark-mermaidjs";

export default defineConfig({
  site: "https://actorkit.dev",
  markdown: {
    remarkPlugins: [
      [
        remarkMermaid,
        {
          mermaidConfig: {
            theme: "dark",
            themeVariables: {
              darkMode: true,
              background: "#0d1117",
              primaryColor: "#f6821f",
              primaryTextColor: "#e6edf3",
              primaryBorderColor: "#f6821f",
              lineColor: "#8b949e",
              secondaryColor: "#1c2028",
              tertiaryColor: "#161b22",
              noteBkgColor: "#161b22",
              noteTextColor: "#c9d1d9",
              actorBkg: "#1c2028",
              actorBorder: "#f6821f",
              actorTextColor: "#e6edf3",
              signalColor: "#8b949e",
              signalTextColor: "#c9d1d9",
            },
          },
        },
      ],
    ],
  },
  integrations: [
    starlight({
      title: "Actor Kit",
      logo: {
        dark: "./src/assets/logo.svg",
        light: "./src/assets/logo-light.svg",
        replacesTitle: false,
      },
      description:
        "Library-agnostic actors on Cloudflare Durable Objects with real-time client sync.",
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
            { slug: "guides/hono-plain-counter" },
            { slug: "guides/xstate" },
            { slug: "guides/xstate-store" },
            { slug: "guides/redux" },
            { slug: "guides/testing" },
            { slug: "guides/storybook" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { slug: "api/core" },
            { slug: "api/types" },
            { slug: "api/browser" },
            { slug: "api/react" },
            { slug: "api/server" },
            { slug: "api/test" },
            { slug: "api/storybook" },
          ],
        },
        {
          label: "More",
          items: [
            { slug: "architecture/system-design" },
            { slug: "roadmap" },
          ],
        },
        {
          label: "LLM Resources",
          items: [
            {
              label: "llms.txt",
              link: "/llms-full.txt",
              attrs: { target: "_blank" },
            },
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
