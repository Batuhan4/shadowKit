import { describe, it, expect, vi } from "vitest";
import { AgentRunner } from "../src/index";
import type { AgentDeps, GovReader } from "../src/index";
import { DeterministicPlanner } from "../src/planner";
import type { AgentLog, AgentLogPhase } from "@shadowkit/shared";

function fakeDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  const govReader: GovReader = {
    capOf: vi.fn(async () => "10000"),
    actionOf: vi.fn(async () => ({
      kind: "swap" as const,
      assetIn: "CUSDC",
      assetOut: "CXLM",
      amount: "10000",
      minOut: "1",
    })),
  };
  return {
    watcher: { waitForApproved: vi.fn(async () => {}) },
    dataClient: { fetchMarket: vi.fn(async () => ({ pair: "USDC/XLM", price: "10", signal: "buy" as const })) },
    govReader,
    executor: { executeSwap: vi.fn(async () => ({ txHash: "tx_swap" })) },
    makeClaudePlanner: () => new DeterministicPlanner(), // unused when useDeterministicPlanner=true
    makeDeterministicPlanner: () => new DeterministicPlanner(),
    ...over,
  };
}
const cfg = {
  rpcUrl: "http://x",
  networkPassphrase: "Test",
  govVaultId: "CGOV",
  agentPolicyId: "CPOL",
  swapVenueId: "CAMM",
  sessionSecretKey: "S...",
  premiumDataUrl: "http://d",
  anthropicApiKey: "k",
  useDeterministicPlanner: true,
};

describe("AgentRunner", () => {
  it("runs watch->data->plan->sign->submit->done and streams phases in order", async () => {
    const deps = fakeDeps();
    const runner = new AgentRunner(cfg, deps);
    const logs: AgentLog[] = [];
    const res = await runner.run(0, (l) => logs.push(l));
    expect(res.txHash).toBe("tx_swap");
    expect(deps.watcher.waitForApproved).toHaveBeenCalledWith(0);
    expect(deps.executor.executeSwap).toHaveBeenCalled();
    const phases = logs.map((l) => l.phase);
    // M2 loop (reveal deferred to M5 — recorded divergence): data->plan->sign->submit->done, in order.
    const expectedOrder: AgentLogPhase[] = ["data", "plan", "sign", "submit", "done"];
    let idx = -1;
    for (const p of expectedOrder) {
      const at = phases.indexOf(p, idx + 1);
      expect(at).toBeGreaterThan(idx);
      idx = at;
    }
    expect(phases).not.toContain("reveal"); // intentionally absent in M2 (plaintext close)
  });

  it("emits an error phase and rethrows when a collaborator fails", async () => {
    const deps = fakeDeps({
      executor: {
        executeSwap: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });
    const runner = new AgentRunner(cfg, deps);
    const logs: AgentLog[] = [];
    await expect(runner.run(0, (l) => logs.push(l))).rejects.toThrow(/boom/);
    expect(logs.map((l) => l.phase)).toContain("error");
  });
});
