import { defineConfig } from "vitest/config";

// Vitest project for the demo-script test (scripts/demo.test.ts). The test is gated on
// RUN_DEMO_TEST=1 (it drives the live local network + real proving + real tlock), so under the
// umbrella `just test` it shows as SKIPPED unless RUN_DEMO_TEST is set — documented, not a bare skip.
export default defineConfig({
  // Resolve includes relative to scripts/ so this config works whether invoked as a root project
  // ("scripts" in the root vitest.config projects array) or directly via --config.
  root: __dirname,
  test: {
    name: "scripts",
    environment: "node",
    include: ["*.test.ts"],
    // The full e2e loop (deploy + 3 real proofs + tlock wait + agent swap) runs well over a minute,
    // twice; give it a generous ceiling.
    testTimeout: 1_300_000,
    hookTimeout: 1_300_000,
  },
});
