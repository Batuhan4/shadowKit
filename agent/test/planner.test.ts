import { describe, it, expect } from "vitest";
import { DeterministicPlanner } from "../src/planner";
import type { ActionSpec } from "@shadowkit/shared";
import type { MarketData } from "../src/dataClient";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC",
  assetOut: "CXLM",
  amount: "15000",
  minOut: "1",
};
const market: MarketData = { pair: "USDC/XLM", price: "10", signal: "buy" };

describe("DeterministicPlanner", () => {
  it("plans amountIn == cap and a positive minOut below market", async () => {
    const p = new DeterministicPlanner({ slippageBps: 100 }); // 1%
    const plan = await p.plan(spec, "15000", market);
    expect(plan.amountIn).toBe("15000");
    expect(BigInt(plan.minOut)).toBeGreaterThan(0n);
    // minOut = amountIn * price * (1 - slippage); with price 10, 1% slip => < 150000
    expect(BigInt(plan.minOut)).toBeLessThan(150000n);
  });

  it("never plans amountIn above cap (cap guard)", async () => {
    const p = new DeterministicPlanner();
    const plan = await p.plan(spec, "9000", market); // cap below spec.amount
    expect(BigInt(plan.amountIn)).toBeLessThanOrEqual(9000n);
  });
});
