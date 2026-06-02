import { describe, it, expect } from "vitest";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/planner.js";
import { DeterministicPlanner } from "../src/planner.js";
import { validatePlan } from "../src/planValidation.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

describe("DeterministicPlanner (M2 fallback, no LLM)", () => {
  it("swaps the full cap when spec.amount == cap (amountIn == cap)", async () => {
    const p = new DeterministicPlanner();
    const plan = await p.plan(spec, cap, market);
    expect(plan.amountIn).toBe(cap);
  });

  it("produces an in-cap, valid plan (passes validatePlan)", async () => {
    const p = new DeterministicPlanner();
    const plan = await p.plan(spec, cap, market);
    expect(() => validatePlan(plan, spec, cap)).not.toThrow();
    expect(BigInt(plan.amountIn) <= BigInt(cap)).toBe(true);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
  });

  it("never plans amountIn above cap (hard cap guard, charter rule 3)", async () => {
    const p = new DeterministicPlanner();
    const lowCap = "9000"; // cap below spec.amount
    const plan = await p.plan(spec, lowCap, market);
    expect(BigInt(plan.amountIn)).toBeLessThanOrEqual(BigInt(lowCap));
  });

  it("derives minOut from market price minus the configured slippage (BigInt math, decimal price)", async () => {
    const p = new DeterministicPlanner({ slippageBps: 50 }); // 0.5%
    const plan = await p.plan(spec, cap, market);
    expect(plan.minOut).toMatch(/^[0-9]+$/);
    expect(BigInt(plan.minOut) > 0n).toBe(true);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
    // price 8.25 * 150000000000 = 1_237_500_000_000; minus 0.5% = 1_231_312_500_000.
    expect(plan.minOut).toBe("1231312500000");
  });

  it("clamps minOut up to the proposal floor when the price-implied output is below it", async () => {
    // A tiny price would imply a below-floor output; minOut must be clamped UP to spec.minOut.
    const tinyPriceMarket: MarketData = { pair: "USDC/XLM", price: "0.000001", signal: "sell" };
    const p = new DeterministicPlanner();
    const plan = await p.plan(spec, cap, tinyPriceMarket);
    expect(BigInt(plan.minOut) >= BigInt(spec.minOut)).toBe(true);
    expect(plan.minOut).toBe(spec.minOut); // clamped exactly to the floor
  });

  it("is fully deterministic: identical inputs → identical plan, no network", async () => {
    const p = new DeterministicPlanner();
    const a = await p.plan(spec, cap, market);
    const b = await p.plan(spec, cap, market);
    expect(a).toEqual(b);
  });

  it("never makes an LLM/network call (no apiKey, no client required)", async () => {
    // Constructing with no config must work — proves it needs no Gemini key.
    const p = new DeterministicPlanner();
    await expect(p.plan(spec, cap, market)).resolves.toBeDefined();
  });
});
