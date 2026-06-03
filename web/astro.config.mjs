// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import remarkGfm from "remark-gfm";

// foundation §1/§6: @astrojs/react integration; vite build target es2020 (tlock-js req at M5).
// docs: @astrojs/starlight serves the `docs` content collection. Files live under
// src/content/docs/docs/** so every doc route is mounted at /docs/* (the site Nav links to /docs),
// while the landing page + /demo/* React pages stay as ordinary src/pages/* routes.
export default defineConfig({
  integrations: [
    starlight({
      title: "ShadowKit",
      description:
        "ZK + AI-agent governance infrastructure for Stellar — private sealed voting, then a bounded agent executes on-chain.",
      // Anonymity-set favicon (charcoal + lime). Versioned to bust browsers' sticky favicon cache.
      favicon: "/favicon.svg?v=3",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Batuhan4/shadowKit",
        },
      ],
      // Anonymity-set theme (charcoal + bone + one lime mark) — see src/styles/starlight.css.
      customCss: ["./src/styles/starlight.css"],
      // Dark-only: force the dark palette and drop the light/dark toggle.
      components: {
        ThemeSelect: "./src/components/starlight/ThemeSelect.astro",
      },
      // Sidebar covers the full reading order; slugs resolve under /docs/*.
      sidebar: [
        { label: "Overview", link: "/docs" },
        { label: "Architecture", link: "/docs/architecture" },
        {
          label: "SDK reference",
          items: [
            { label: "Packages", link: "/docs/packages" },
            { label: "Contracts", link: "/docs/contracts" },
            { label: "Circuits", link: "/docs/circuits" },
            { label: "Agent", link: "/docs/agent" },
            { label: "x402", link: "/docs/x402" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Integrate ShadowKit", link: "/docs/integrate" },
            { label: "Sealed-voting flow", link: "/docs/sealed-voting-flow" },
          ],
        },
      ],
    }),
    react(),
  ],
  // site: canonical origin (the public custom domain) — Starlight uses it for sitemap/canonical.
  site: "https://shadowkit.nexvar.io",
  // GFM (tables, strikethrough, autolinks) for both .md and .mdx. The Starlight docs use markdown
  // tables (Contracts/Packages entrypoint tables); without remark-gfm they render as raw `| … |` text.
  markdown: { remarkPlugins: [remarkGfm] },
  vite: {
    // es2022 (not es2020): Starlight + some deps emit top-level await, which needs es2022+.
    // tlock-js (the M5 reason for the old es2020 pin) works fine at es2022 (superset).
    build: { target: "es2022" },
  },
});
