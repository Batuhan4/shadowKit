// ShadowKit SELLS verify/execute (foundation §3.6). Paywall via @shadowkit/x402-shared (REAL x402).
// Provider gate via assertApproved (src/gating.ts). Off-chain verify via @shadowkit/zk-prover.
// /execute KICKS the agent for an approved proposal (spec §6 step 6) via an injected runAgent fn.
import express from "express";
import { buildStellarResourceServer, type StellarNetwork } from "@shadowkit/x402-shared";
import { verifyVoteProof } from "@shadowkit/zk-prover";
import type { PublicSignals, Groth16Proof } from "@shadowkit/shared";
import { assertApproved, ProposalNotApprovedError } from "./gating.js";
import { loadVkey } from "./vkey.js";

export interface ShadowKitApiCfg {
  payTo: string;
  network: StellarNetwork;
  priceUsdc: string;
  facilitatorUrl: string;
  govVaultId: string;
  rpcUrl: string;
  /** Fallback (foundation M6): "agent-pays-only" runs this SELL side UNGATED (no paywall). */
  direction?: "both" | "agent-pays-only";
  /** Injected on-chain read of GovVault.is_approved (server.ts wires the real binding by default). */
  readApproved?: (id: number) => Promise<boolean>;
  /** Injected agent kick: triggers the agent for an approved proposal and returns its txHash
   *  (server.ts wires the real AgentRunner by default). Returns the swap tx hash. */
  runAgent?: (proposalId: number) => Promise<{ txHash: string }>;
}

export function createShadowKitApiServer(cfg: ShadowKitApiCfg): express.Express {
  const app = express();
  const vkey = loadVkey();
  const readApproved = cfg.readApproved ?? ((id: number) => defaultReadApproved(cfg, id));
  const runAgent = cfg.runAgent ?? ((id: number) => defaultRunAgent(cfg, id));

  // express.json() MUST run BEFORE the handlers so req.body is parsed. The x402 paywall is a
  // separate middleware that reads the X-PAYMENT header (not the JSON body), so json() can sit
  // alongside it; we register json() first so BOTH the paywall and the handlers see a parsed body.
  app.use(express.json({ limit: "2mb" }));

  // FALLBACK SWITCH: in agent-pays-only mode the SELL side is NOT paywalled (one-direction x402).
  if ((cfg.direction ?? "both") === "both") {
    app.use(
      buildStellarResourceServer({
        routes: {
          "POST /verify": { payTo: cfg.payTo, price: cfg.priceUsdc, network: cfg.network },
          "POST /execute": { payTo: cfg.payTo, price: cfg.priceUsdc, network: cfg.network },
        },
        network: cfg.network,
        facilitatorUrl: cfg.facilitatorUrl,
      }),
    );
  }

  app.post("/verify", async (req, res) => {
    try {
      const { proof, publicSignals } = req.body as {
        proof: Groth16Proof;
        publicSignals: PublicSignals;
      };
      const ok = await verifyVoteProof(vkey, publicSignals, proof);
      res.json({ valid: ok });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  app.post("/execute", async (req, res) => {
    const proposalId = Number(req.body?.proposalId);
    try {
      await assertApproved(proposalId, readApproved);
      // KICK the agent for the approved proposal (spec §6 step 6) and return the resulting swap tx hash.
      const { txHash } = await runAgent(proposalId);
      res.json({ accepted: true, proposalId, txHash });
    } catch (e) {
      if (e instanceof ProposalNotApprovedError) {
        res.status(403).json({ error: e.message });
        return;
      }
      res.status(400).json({ error: String(e) });
    }
  });
  return app;
}

// Real GovVault read via the generated binding client (foundation §1: @shadowkit/shared/bindings).
// Imported lazily to keep the unit test (which injects readApproved) free of RPC.
// VERIFIED 2026-06-03 against the generated client: the barrel is `@shadowkit/shared/bindings`
// exporting the `GovVault` namespace (NOT `@shadowkit/shared/bindings/gov-vault` as the plan drafted);
// `is_approved({ id }): Promise<AssembledTransaction<boolean>>` whose `.result` holds the simulated bool.
async function defaultReadApproved(cfg: ShadowKitApiCfg, id: number): Promise<boolean> {
  const { GovVault } = await import("@shadowkit/shared/bindings");
  const client = new GovVault.Client({
    contractId: cfg.govVaultId,
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: process.env.NETWORK_PASSPHRASE!,
    allowHttp: cfg.rpcUrl.startsWith("http://"),
  });
  const tx = await client.is_approved({ id });
  return Boolean(tx.result);
}

// Real agent kick via @shadowkit/agent AgentRunner (foundation §3.5). Lazily imported so the unit/
// server tests (which inject runAgent) need no agent deps at module load.
async function defaultRunAgent(cfg: ShadowKitApiCfg, id: number): Promise<{ txHash: string }> {
  const { AgentRunner } = await import("@shadowkit/agent");
  const runner = new AgentRunner({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: process.env.NETWORK_PASSPHRASE!,
    govVaultId: cfg.govVaultId,
    agentPolicyId: process.env.AGENT_POLICY_ID!,
    swapVenueId: process.env.SWAP_VENUE_ID ?? process.env.FALLBACK_AMM_ID!,
    sessionSecretKey: process.env.AGENT_SESSION_SECRET!,
    premiumDataUrl: process.env.PREMIUM_DATA_URL!,
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    useDeterministicPlanner: (process.env.USE_DETERMINISTIC_PLANNER ?? "true") === "true",
  });
  return runner.run(id, () => {}); // streams to a no-op log sink here; the demo uses a real LogBus
}
