import { defineConfig } from "vitest/config";

// Worker-side (Pages Functions) test config — SEPARATE from web/vitest.config.ts so the agent
// AgentBoard handler/logic tests run in the node environment (no jsdom, no React plugin) and only
// pick up functions/**/*.test.ts. Run with:  npx vitest run --config web/functions/vitest.config.ts
export default defineConfig({
  test: {
    name: "web-functions",
    include: ["**/*.test.ts"],
    environment: "node",
    globals: true,
    root: import.meta.dirname,
  },
});
