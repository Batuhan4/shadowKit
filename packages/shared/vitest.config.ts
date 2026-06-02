import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node", // framework-free types/helpers; no DOM needed
    include: ["src/**/*.test.ts"],
  },
});
