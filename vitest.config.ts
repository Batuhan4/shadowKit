// vitest.config.ts — root Vitest config. Aggregates every TS package as a PROJECT.
// Vitest 4 removed `defineWorkspace`/`vitest.workspace.ts`; use `test.projects` instead.
// Verified ctx7 /vitest-dev/vitest v4.1.6 migration guide ("workspace -> projects"), 2026-06-02.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",      // @shadowkit/shared (+ stub pkgs) — default node env
      "agent",           // @shadowkit/agent stub
      "x402-services/*", // x402 service stubs
      "web",             // loads web/vitest.config.ts (jsdom + @vitejs/plugin-react)
    ],
  },
});
