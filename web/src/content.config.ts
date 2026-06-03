// Astro content collections. Starlight owns the `docs` collection (src/content/docs/**),
// which it mounts as routes. The landing page (src/pages/index.astro) and the React demo
// pages (src/pages/demo/*) are plain Astro pages and are NOT part of any collection.
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
