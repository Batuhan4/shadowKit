// agent/src/run-e2e.ts — the LIVE-network agent driver for `just e2e-hero` (Task M2-16).
//
// Runs the M2 agent middleware end-to-end against the running local Stellar quickstart container:
//   watch (GovVault.proposal.status -> Approved) -> data -> plan (DeterministicPlanner, cap guard)
//   -> sign -> submit (StellarChainGateway: FallbackAMM.swap on-chain, REAL session-key signature)
//   -> mark_executed (GovVault) -> done.
//
// It wires the REAL modules — the real Watcher (live RPC reads), the real Executor over the REAL
// StellarChainGateway (builds + signs + sends the swap and mark_executed via @stellar/stellar-sdk),
// and the real GovReader (live cap_of/action_of). This is the path that actually exercises the agent
// submit code against the live container (NOT a mock).
//
// DataClient: the M2 DataClient is an explicit stub (the real x402-paying client lands in M6,
// foundation §3.5). We feed it a 1:1 market price via setInjected so the DeterministicPlanner's
// minOut is realistic for the seeded ~1:1 FallbackAMM pool. Everything else is the real path.
//
// TREASURY / AUTH (charter rule 4, recorded divergence — see scripts/e2e-hero.sh + the M2 plan's
// Verification log): the on-network treasury is the agent's CLASSIC session account (the swap's `to`
// == the tx source, so `FallbackAMM.swap`'s `to.require_auth()` is satisfied by the source signature).
// The OZ smart-account-HOSTED treasury whose custom `__check_auth` runs `AgentPolicy.enforce` is NOT
// driven here because (1) no OZ host WASM is deployable (the host is `#![cfg(test)]`), and (2) the OZ
// custom `AuthPayload` signature format (sha256(payload || rule_ids.to_xdr()), Map<Signer,Bytes>)
// cannot be produced by `stellar` CLI / basicNodeSigner.signAuthEntry. The full host-gated `enforce`
// path (live cross-read + REAL ed25519 session signature, allow + NotApproved-block) is proven by the
// in-Env agent-policy integration tests (hero_loop_moves_balances / execute_without_quorum_is_blocked
// / cross_read_in_enforce_during_auth). This driver proves the REAL agent submit pipeline + REAL
// on-chain balance movement + proposal->Executed transition on the live network.

// Minimal ambient `process` decl: this file is a node entry script (run via
// `node --experimental-strip-types`), and the repo intentionally has no @types/node dependency. We
// only touch env + exit, so a narrow local declaration keeps `tsc --noEmit` (npm run build) green
// without pulling a new devDependency.
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

import { AgentRunner, type AgentConfig, type AgentDeps, type GovReader } from "./index";
import { Watcher } from "./watcher";
import { Executor } from "./executor";
import { DataClient } from "./dataClient";
import { DeterministicPlanner } from "./planner";
import type { ActionSpec, AgentLog } from "@shadowkit/shared";
import { contract } from "@stellar/stellar-sdk";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`run-e2e: missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const proposalId = Number(process.env.PROPOSAL_ID ?? "0");
  const rpcUrl = process.env.LOCAL_RPC_URL ?? "http://localhost:8000/rpc";
  const networkPassphrase = process.env.LOCAL_NETWORK_PASSPHRASE ?? "Standalone Network ; February 2017";
  const govVaultId = req("GOV_VAULT_ID");
  const ammId = req("AMM_ID");
  const treasuryAddr = req("TREASURY_ADDR");
  const sessionSecretKey = req("TREASURY_SECRET");

  const cfg: AgentConfig = {
    rpcUrl,
    networkPassphrase,
    govVaultId,
    // The swap's `to` == treasury (Executor uses cfg.agentPolicyId as the swap `to`/treasury). For the
    // classic-account treasury, that IS the session account, so source-sig satisfies to.require_auth().
    agentPolicyId: treasuryAddr,
    swapVenueId: ammId,
    sessionSecretKey,
    premiumDataUrl: process.env.PREMIUM_DATA_URL ?? "http://localhost:0",
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    useDeterministicPlanner: true,
  };

  // Build the REAL deps explicitly (real Watcher, real Executor->StellarChainGateway, real GovReader).
  // Only the DataClient (an M2 stub) gets injected market data — the real submit path is untouched.
  const watcher = new Watcher({ rpcUrl, govVaultId, networkPassphrase });
  const executor = new Executor({
    rpcUrl,
    networkPassphrase,
    agentPolicyId: treasuryAddr,
    swapVenueId: ammId,
    sessionSecretKey,
    govVaultId,
  });
  const dataClient = new DataClient({ url: cfg.premiumDataUrl, signerSecret: sessionSecretKey, network: networkPassphrase });
  // 1:1 market so DeterministicPlanner.minOut (price*amount*(1-50bps)) sits below the seeded ~1:1 pool's out.
  dataClient.setInjected({ pair: "USDC/XLM", price: "1", signal: "buy" });

  const readProposal = async (id: number) => {
    const c = await contract.Client.from({ contractId: govVaultId, networkPassphrase, rpcUrl, allowHttp: rpcUrl.startsWith("http://") });
    const tx = await (c as unknown as { proposal: (a: { id: number }) => Promise<{ result: unknown }> }).proposal({ id });
    const r = tx.result as { unwrap?: () => unknown } | undefined;
    return (r && typeof r.unwrap === "function" ? r.unwrap() : r) as {
      action_spec: { asset_in: string; asset_out: string; amount: bigint; min_out: bigint };
      cap: bigint;
    };
  };
  const govReader: GovReader = {
    capOf: async (id) => (await readProposal(id)).cap.toString(),
    actionOf: async (id): Promise<ActionSpec> => {
      const s = (await readProposal(id)).action_spec;
      return { kind: "swap", assetIn: s.asset_in, assetOut: s.asset_out, amount: s.amount.toString(), minOut: s.min_out.toString() };
    },
  };

  const deps: AgentDeps = {
    watcher: { waitForApproved: (id, pollMs) => watcher.waitForApproved(id, pollMs) },
    dataClient: { fetchMarket: (pair) => dataClient.fetchMarket(pair) },
    govReader,
    executor: { executeSwap: (plan, spec, cap, id) => executor.executeSwap(plan, spec, cap, id) },
    makeClaudePlanner: () => new DeterministicPlanner(),
    makeDeterministicPlanner: () => new DeterministicPlanner(),
  };

  const runner = new AgentRunner(cfg, deps);
  const logs: AgentLog[] = [];
  const res = await runner.run(proposalId, (l) => {
    logs.push(l);
    console.log(`[agent:${l.phase}] ${l.message}${l.txHash ? ` (tx=${l.txHash})` : ""}`);
  });
  console.log(`AGENT_DONE txHash=${res.txHash}`);
}

main().catch((err) => {
  console.error(`AGENT_FAILED: ${(err as Error).message}`);
  process.exit(1);
});
