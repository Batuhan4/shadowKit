import { describe, it, expect, vi } from "vitest";
import type { ActionSpec, AgentLog } from "@shadowkit/shared";
import type { ActionPlan, MarketData, Planner } from "../src/planner.js";
import { AgentRunner } from "../src/index.js";

const spec: ActionSpec = {
  kind: "swap",
  assetIn: "CUSDC0000000000000000000000000000000000000000000000000000000",
  assetOut: "CXLM00000000000000000000000000000000000000000000000000000000",
  amount: "150000000000",
  minOut: "1000000000",
};
const cap = "150000000000";
const market: MarketData = { pair: "USDC/XLM", price: "8.25", signal: "buy" };

const baseCfg = {
  rpcUrl: "http://localhost:8000/rpc",
  networkPassphrase: "Test SDF Network ; September 2015",
  govVaultId: "CGOV0000000000000000000000000000000000000000000000000000000",
  agentPolicyId: "CPOL0000000000000000000000000000000000000000000000000000000",
  swapVenueId: "CAMM0000000000000000000000000000000000000000000000000000000",
  sessionSecretKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  premiumDataUrl: "http://localhost:4021/market/USDC-XLM",
  geminiApiKey: "test",
  useDeterministicPlanner: false,
};

// Fake deps the runner uses. AgentRunner accepts these via its second ctor arg (injection seam).
function fakeDeps(opts: { geminiPlan?: ActionPlan | Error }) {
  const executeSwap = vi.fn(async () => ({ txHash: "TXHASH123" }));
  return {
    watcher: { waitForApproved: vi.fn(async () => undefined) },
    dataClient: { fetchMarket: vi.fn(async () => market) },
    govReader: {
      capOf: vi.fn(async () => cap),
      actionOf: vi.fn(async () => spec),
    },
    executor: { executeSwap },
    // Primary (Gemini) planner factory: returns a Planner whose plan() resolves/rejects per option.
    makeClaudePlanner: (): Planner => ({
      plan: async () => {
        if (opts.geminiPlan instanceof Error) throw opts.geminiPlan;
        return opts.geminiPlan ?? { amountIn: cap, minOut: "1200000000", reasoning: "llm plan" };
      },
    }),
    makeDeterministicPlanner: (): Planner => ({
      plan: async () => ({ amountIn: cap, minOut: "1100000000", reasoning: "deterministic plan" }),
    }),
    _executeSwap: executeSwap,
  };
}

describe("AgentRunner planner selection + auto-fallback + idempotency", () => {
  it("uses GeminiPlanner when useDeterministicPlanner=false", async () => {
    const deps = fakeDeps({});
    const runner = new AgentRunner(baseCfg, deps);
    const logs: AgentLog[] = [];
    const res = await runner.run(0, (l) => logs.push(l));

    expect(res.txHash).toBe("TXHASH123");
    // executor called exactly once with the LLM plan's amounts (single-shot / idempotent).
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
    const [planArg] = deps._executeSwap.mock.calls[0]!;
    expect(planArg.reasoning).toBe("llm plan");
    // a "plan" phase and a terminal "done" phase were logged.
    expect(logs.some((l) => l.phase === "plan")).toBe(true);
    expect(logs.some((l) => l.phase === "done")).toBe(true);
  });

  it("uses DeterministicPlanner when useDeterministicPlanner=true (config fallback)", async () => {
    const deps = fakeDeps({});
    const runner = new AgentRunner({ ...baseCfg, useDeterministicPlanner: true }, deps);
    await runner.run(0, () => {});
    const [planArg] = deps._executeSwap.mock.calls[0]!;
    expect(planArg.reasoning).toBe("deterministic plan");
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
  });

  it("AUTO-FALLS-BACK to DeterministicPlanner when GeminiPlanner throws", async () => {
    const deps = fakeDeps({ geminiPlan: new Error("LLM unavailable") });
    const runner = new AgentRunner(baseCfg, deps); // useDeterministicPlanner=false
    const logs: AgentLog[] = [];
    const res = await runner.run(0, (l) => logs.push(l));

    expect(res.txHash).toBe("TXHASH123");
    const [planArg] = deps._executeSwap.mock.calls[0]!;
    expect(planArg.reasoning).toBe("deterministic plan"); // fell back
    // the fallback was logged as an error-phase event (visible in the terminal).
    expect(logs.some((l) => l.phase === "error" && /fallback/i.test(l.message))).toBe(true);
    // still exactly one execution — idempotency preserved across the fallback.
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
  });

  it("AUTO-FALLS-BACK when GeminiPlanner returns an over-cap plan (caught by validatePlan inside planner)", async () => {
    // GeminiPlanner.plan itself throws OVER_CAP (Task 3); simulate by rejecting.
    const deps = fakeDeps({ geminiPlan: new Error("OVER_CAP: amountIn exceeds cap") });
    const runner = new AgentRunner(baseCfg, deps);
    await runner.run(0, () => {});
    const [planArg] = deps._executeSwap.mock.calls[0]!;
    expect(planArg.reasoning).toBe("deterministic plan");
    expect(deps._executeSwap).toHaveBeenCalledTimes(1);
  });
});
