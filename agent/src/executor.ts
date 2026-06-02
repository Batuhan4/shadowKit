import type { ActionSpec } from "@shadowkit/shared";
import type { ActionPlan } from "./planner";
import { normalizeStatus } from "./watcher";
import { contract, Keypair } from "@stellar/stellar-sdk";

// basicNodeSigner is exported from @stellar/stellar-sdk/contract (re-exported under the `contract`
// namespace), NOT the top-level surface. Verified 2026-06-02: lib/contract/basic_node_signer.d.ts.
const { basicNodeSigner } = contract;

export interface SwapArgs {
  assetIn: string;
  amountIn: string;
  minOut: string;
  to: string;
}

/** Config switch (foundation §2.4): pick the swap venue contract id by SWAP_VENUE, never a code fork.
 *  Both venues implement the same SwapVenue trait, so the only difference is WHICH contract id the
 *  Executor submits to. Defaults to the always-green FallbackAMM for any value other than "soroswap". */
export function selectSwapVenueId(
  mode: string,
  ids: { fallbackAmmId: string; soroswapAdapterId: string },
): string {
  return mode === "soroswap" ? ids.soroswapAdapterId : ids.fallbackAmmId;
}

/** The network boundary as a small interface (seam). Default impl = StellarChainGateway (real). */
export interface ChainGateway {
  submitSwap(args: SwapArgs): Promise<{ txHash: string }>;
  markExecuted(proposalId: number): Promise<{ txHash: string }>;
  isExecuted(proposalId: number): Promise<boolean>;
}

export interface ExecutorCfg {
  rpcUrl: string;
  networkPassphrase: string;
  agentPolicyId: string;
  swapVenueId: string;
  sessionSecretKey: string;
  govVaultId?: string;
}

export class Executor {
  private gw: ChainGateway;
  constructor(private cfg: ExecutorCfg, gateway?: ChainGateway) {
    this.gw = gateway ?? new StellarChainGateway({ ...cfg, govVaultId: cfg.govVaultId ?? "" });
  }
  /** CLIENT-SIDE cap guard (defense-in-depth, foundation §3.5) -> build+sign+submit swap -> mark executed.
   *  Idempotent on proposalId. The ON-CHAIN AgentPolicy.enforce is the real gate; this is belt+braces. */
  async executeSwap(
    plan: ActionPlan,
    spec: ActionSpec,
    cap: string,
    proposalId: number,
  ): Promise<{ txHash: string }> {
    if (BigInt(plan.amountIn) > BigInt(cap)) {
      throw new Error(`client cap guard: amountIn ${plan.amountIn} exceeds cap ${cap}`);
    }
    if (await this.gw.isExecuted(proposalId)) return { txHash: "" }; // idempotent
    const args: SwapArgs = {
      assetIn: spec.assetIn,
      amountIn: plan.amountIn,
      minOut: plan.minOut,
      to: this.cfg.agentPolicyId /* treasury = smart-account wallet */,
    };
    const swapRes = await this.gw.submitSwap(args);
    await this.gw.markExecuted(proposalId);
    return swapRes;
  }
}

/** REAL chain gateway. Builds + signs (basicNodeSigner over the session key) + sends via stellar-sdk.
 *  SOURCE: @stellar/stellar-sdk AssembledTransaction.signAuthEntries/.signAndSend, basicNodeSigner,
 *  SentTransaction.sendTransactionResponse.hash (verified 2026-06-02, lib/contract/*.d.ts). */
export class StellarChainGateway implements ChainGateway {
  // Initialized in the constructor body (NOT a field initializer): class field initializers run
  // BEFORE TS parameter-property assignment, so `this.cfg` would be undefined at field-init time.
  private signer: ReturnType<typeof basicNodeSigner>;
  constructor(private cfg: ExecutorCfg & { govVaultId: string }) {
    this.signer = basicNodeSigner(Keypair.fromSecret(cfg.sessionSecretKey), cfg.networkPassphrase);
  }

  /** Build a contract.Client for a contract id (overridable seam for transport tests). */
  protected async client(contractId: string): Promise<contract.Client> {
    return contract.Client.from({
      contractId,
      networkPassphrase: this.cfg.networkPassphrase,
      rpcUrl: this.cfg.rpcUrl,
      allowHttp: this.cfg.rpcUrl.startsWith("http://"),
      publicKey: Keypair.fromSecret(this.cfg.sessionSecretKey).publicKey(),
    });
  }

  async submitSwap(args: SwapArgs): Promise<{ txHash: string }> {
    const c = await this.client(this.cfg.swapVenueId);
    // read the AssembledTransaction, sign the smart-account auth entries (session key), then send.
    const tx = await (
      c as unknown as {
        swap: (a: { asset_in: string; amount_in: bigint; min_out: bigint; to: string }) => Promise<{
          signAuthEntries(o: unknown): Promise<void>;
          signAndSend(o: unknown): Promise<{ sendTransactionResponse?: { hash: string } }>;
        }>;
      }
    ).swap({
      asset_in: args.assetIn,
      amount_in: BigInt(args.amountIn),
      min_out: BigInt(args.minOut),
      to: args.to,
    });
    await tx.signAuthEntries({ address: this.cfg.agentPolicyId, authorizeEntry: this.signer.signAuthEntry });
    const sent = await tx.signAndSend({ signTransaction: this.signer.signTransaction });
    return { txHash: sent.sendTransactionResponse?.hash ?? "" };
  }

  async markExecuted(proposalId: number): Promise<{ txHash: string }> {
    const c = await this.client(this.cfg.govVaultId);
    const tx = await (
      c as unknown as {
        mark_executed: (a: { id: number }) => Promise<{
          signAndSend(o: unknown): Promise<{ sendTransactionResponse?: { hash: string } }>;
        }>;
      }
    ).mark_executed({ id: proposalId });
    const sent = await tx.signAndSend({ signTransaction: this.signer.signTransaction });
    return { txHash: sent.sendTransactionResponse?.hash ?? "" };
  }

  async isExecuted(proposalId: number): Promise<boolean> {
    const c = await this.client(this.cfg.govVaultId);
    const tx = await (
      c as unknown as { proposal: (a: { id: number }) => Promise<{ result: unknown }> }
    ).proposal({ id: proposalId });
    // normalizeStatus tolerates both the live Result<ProposalView>+tagged-enum shape and the
    // transport-test plain-string shape (see watcher.ts).
    return normalizeStatus(tx.result) === "Executed";
  }
}
