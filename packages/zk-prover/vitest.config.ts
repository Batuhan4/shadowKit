import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // snarkjs witness calculation + Groth16 proving over BLS12-381 is slow.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
