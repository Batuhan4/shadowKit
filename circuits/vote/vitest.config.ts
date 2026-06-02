import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Groth16 proving over BLS12-381 + witness calculation is slow; give each test room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
