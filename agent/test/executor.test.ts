import { describe, it, expect, vi } from "vitest";
import { Executor, type ChainGateway } from "../src/executor";
import type { ActionSpec } from "@shadowkit/shared";
import type { ActionPlan } from "../src/planner";

const spec: ActionSpec = { kind: "swap", assetIn: "CUSDC", assetOut: "CXLM", amount: "10000", minOut: "1" };

// A real Stellar testnet secret seed (well-formed S... strkey) so Keypair.fromSecret parses.
const SESSION_SECRET = "SCJ6YG5H3XRKPEVCVN6NG2CX5RY4JMDCJKB77JA7HTIAMKQ5MHETAAHM";

function fakeGateway(over: Partial<ChainGateway> = {}) {
  const submitSwap = vi.fn(async () => ({ txHash: "tx_swap" }));
  const markExecuted = vi.fn(async () => ({ txHash: "tx_mark" }));
  const isExecuted = vi.fn(async () => false);
  const gw: ChainGateway = { submitSwap, markExecuted, isExecuted, ...over };
  return { gw, submitSwap, markExecuted, isExecuted };
}
function makeExecutor(gw: ChainGateway) {
  return new Executor(
    {
      rpcUrl: "http://x",
      networkPassphrase: "Test",
      agentPolicyId: "CPOL",
      swapVenueId: "CAMM",
      sessionSecretKey: SESSION_SECRET,
    },
    gw,
  );
}

describe("Executor control flow", () => {
  it("rejects a plan whose amountIn exceeds cap (client cap guard)", async () => {
    const { gw } = fakeGateway();
    const e = makeExecutor(gw);
    const overCap: ActionPlan = { amountIn: "10001", minOut: "1", reasoning: "" };
    await expect(e.executeSwap(overCap, spec, "10000", 0)).rejects.toThrow(/cap/i);
  });

  it("builds + submits the swap then marks executed (correct args)", async () => {
    const { gw, submitSwap, markExecuted } = fakeGateway();
    const e = makeExecutor(gw);
    const plan: ActionPlan = { amountIn: "10000", minOut: "9000", reasoning: "" };
    const res = await e.executeSwap(plan, spec, "10000", 0);
    expect(res.txHash).toBe("tx_swap");
    expect(submitSwap).toHaveBeenCalledWith(
      expect.objectContaining({ assetIn: "CUSDC", amountIn: "10000", minOut: "9000" }),
    );
    expect(markExecuted).toHaveBeenCalledWith(0);
  });

  it("is idempotent: if already executed, does not submit again", async () => {
    const { gw, submitSwap } = fakeGateway({ isExecuted: vi.fn(async () => true) });
    const e = makeExecutor(gw);
    const plan: ActionPlan = { amountIn: "10000", minOut: "9000", reasoning: "" };
    const res = await e.executeSwap(plan, spec, "10000", 0);
    expect(submitSwap).not.toHaveBeenCalled();
    expect(res.txHash).toBe("");
  });
});

describe("StellarChainGateway (REAL impl, RPC transport mocked)", () => {
  it("submitSwap builds the AssembledTransaction, signs auth entries + sends, returns the tx hash", async () => {
    // Mock @stellar/stellar-sdk so the REAL StellarChainGateway code runs (client.swap -> signAuthEntries
    // -> signAndSend) but the network is a stub (the `client()` seam is stubbed, not submitSwap itself).
    const { StellarChainGateway } = await import("../src/executor");
    const signAndSend = vi.fn(async () => ({ sendTransactionResponse: { hash: "real_tx_hash" } }));
    const signAuthEntries = vi.fn(async () => {});
    const swap = vi.fn(async () => ({ signAuthEntries, signAndSend }));
    vi.spyOn(
      StellarChainGateway.prototype as unknown as { client(): Promise<{ swap: typeof swap }> },
      "client",
    ).mockResolvedValue({ swap } as never);
    const gw = new StellarChainGateway({
      rpcUrl: "http://rpc",
      networkPassphrase: "Test",
      swapVenueId: "CAMM",
      govVaultId: "CGOV",
      agentPolicyId: "CPOL",
      sessionSecretKey: SESSION_SECRET,
    });
    const res = await gw.submitSwap({ assetIn: "CUSDC", amountIn: "10000", minOut: "9000", to: "CPOL" });
    expect(res.txHash).toBe("real_tx_hash");
    expect(swap).toHaveBeenCalled();
    expect(signAuthEntries).toHaveBeenCalled();
    expect(signAndSend).toHaveBeenCalled();
  });
});
