// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// foundation §1/§6: @astrojs/react integration; vite build target es2020 (tlock-js req at M5)
export default defineConfig({
  integrations: [react()],
  vite: {
    build: { target: "es2020" },
  },
});
