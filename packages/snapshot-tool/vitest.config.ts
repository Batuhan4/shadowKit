import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Poseidon over BLS12-381 circuit wasm (per hash) makes tree builds slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
