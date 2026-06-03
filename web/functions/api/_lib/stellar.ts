// Worker-side Stellar/Soroban client helpers for the AgentBoard live loop. Runs on the Cloudflare
// Workers runtime (nodejs_compat) — @stellar/stellar-sdk drives all RPC over fetch (no fs/temp).
//
// Three responsibilities, each behind a small interface so execute.test.ts can fake ONLY the network
// boundary (never the policy/loop logic):
//   - GovReader   : read GovVault.proposal(id) -> { approved, executed, cap, spec }  (read-only)
//   - Balances    : read the treasury's assetIn/assetOut SAC balances (read-only)
//   - SwapSubmit  : build + sign (EXECUTOR_SECRET) + submit the swap, return the real tx hash
//
// SOURCE: ported from agent/src/{watcher,executor,index}.ts (verified against @stellar/stellar-sdk
// AssembledTransaction / basicNodeSigner / contract.Client.from, lib/contract/*.d.ts 2026-06-03).
import type { ActionSpec } from "@shadowkit/shared";
import { contract, Keypair } from "@stellar/stellar-sdk";

const { basicNodeSigner } = contract;

export interface ChainCfg {
  rpcUrl: string;
  networkPassphrase: string;
  govVaultId: string;
  swapVenueId: string;
  /** The treasury / swap `to` address (the AgentPolicy smart-account or classic treasury). */
  treasuryAddr: string;
  usdcId: string;
  wxlmId: string;
}

export interface ProposalRead {
  approved: boolean;
  executed: boolean;
  cap: string;
  spec: ActionSpec;
}

export interface GovReader {
  readProposal(proposalId: number): Promise<ProposalRead>;
}

export interface TreasuryBalances {
  assetIn: string;
  assetOut: string;
}

export interface Executor {
  treasuryBalances(spec: ActionSpec): Promise<TreasuryBalances>;
  submitSwap(args: { assetIn: string; amountIn: string; minOut: string }): Promise<{ txHash: string }>;
  /** Flip the GovVault proposal to Executed (single-shot) after a successful swap. Signed by the
   *  executor key; require_auth(executor) is satisfied by the source signature. */
  markExecuted(id: number): Promise<{ txHash: string }>;
}

/** Normalize a GovVault.proposal(id) result, tolerating Result<ProposalView> (live) shape:
 *  `.unwrap()` -> ProposalView, with `status` decoding to a tagged enum `{ tag: "Approved" }`. */
function normalizeProposal(result: unknown): ProposalRead {
  const r = result as { unwrap?: () => unknown } | undefined;
  const view = (r && typeof r.unwrap === "function" ? r.unwrap() : r) as
    | {
        status?: { tag?: string } | string;
        cap?: bigint | number | string;
        action_spec?: { asset_in: string; asset_out: string; amount: bigint; min_out: bigint };
      }
    | undefined;
  const statusTag =
    view?.status && typeof view.status === "object" && typeof view.status.tag === "string"
      ? view.status.tag
      : (view?.status as string | undefined);
  const s = view?.action_spec;
  return {
    approved: statusTag === "Approved",
    executed: statusTag === "Executed",
    cap: view?.cap !== undefined ? String(view.cap) : "0",
    spec: {
      kind: "swap",
      assetIn: s ? s.asset_in : "",
      assetOut: s ? s.asset_out : "",
      amount: s ? s.amount.toString() : "0",
      minOut: s ? s.min_out.toString() : "0",
    },
  };
}

/** REAL GovVault read-adapter (read-only invoke; no signing). */
export class StellarGovReader implements GovReader {
  constructor(private cfg: Pick<ChainCfg, "rpcUrl" | "networkPassphrase" | "govVaultId">) {}

  protected async client(contractId: string): Promise<contract.Client> {
    return contract.Client.from({
      contractId,
      networkPassphrase: this.cfg.networkPassphrase,
      rpcUrl: this.cfg.rpcUrl,
      allowHttp: this.cfg.rpcUrl.startsWith("http://"),
    });
  }

  async readProposal(proposalId: number): Promise<ProposalRead> {
    const c = await this.client(this.cfg.govVaultId);
    const tx = await (
      c as unknown as { proposal: (a: { id: number }) => Promise<{ result: unknown }> }
    ).proposal({ id: proposalId });
    return normalizeProposal(tx.result);
  }
}

/** REAL executor: SAC balance reads + swap submit signed with the EXECUTOR_SECRET session key. */
export class StellarExecutor implements Executor {
  private signer: ReturnType<typeof basicNodeSigner>;
  private executorPk: string;
  constructor(
    private cfg: ChainCfg,
    private executorSecret: string,
  ) {
    this.signer = basicNodeSigner(Keypair.fromSecret(executorSecret), cfg.networkPassphrase);
    this.executorPk = Keypair.fromSecret(executorSecret).publicKey();
  }

  protected async client(contractId: string): Promise<contract.Client> {
    return contract.Client.from({
      contractId,
      networkPassphrase: this.cfg.networkPassphrase,
      rpcUrl: this.cfg.rpcUrl,
      allowHttp: this.cfg.rpcUrl.startsWith("http://"),
      publicKey: this.executorPk,
    });
  }

  /** Read a SEP-41/SAC token `balance(addr)` (read-only simulate; returns i128 string). */
  private async balanceOf(tokenId: string, addr: string): Promise<string> {
    const c = await this.client(tokenId);
    try {
      const tx = await (
        c as unknown as { balance: (a: { id: string }) => Promise<{ result: unknown }> }
      ).balance({ id: addr });
      const v = tx.result as bigint | number | string | undefined;
      return v !== undefined && v !== null ? String(v) : "0";
    } catch {
      return "0"; // missing trustline / not yet funded reads as zero for display
    }
  }

  async treasuryBalances(spec: ActionSpec): Promise<TreasuryBalances> {
    const [assetIn, assetOut] = await Promise.all([
      this.balanceOf(spec.assetIn, this.cfg.treasuryAddr),
      this.balanceOf(spec.assetOut, this.cfg.treasuryAddr),
    ]);
    return { assetIn, assetOut };
  }

  async submitSwap(args: {
    assetIn: string;
    amountIn: string;
    minOut: string;
  }): Promise<{ txHash: string }> {
    const c = await this.client(this.cfg.swapVenueId);
    const tx = await (
      c as unknown as {
        swap: (a: {
          asset_in: string;
          amount_in: bigint;
          min_out: bigint;
          to: string;
        }) => Promise<{
          signAuthEntries(o: unknown): Promise<void>;
          signAndSend(o: unknown): Promise<{ sendTransactionResponse?: { hash: string } }>;
        }>;
      }
    ).swap({
      asset_in: args.assetIn,
      amount_in: BigInt(args.amountIn),
      min_out: BigInt(args.minOut),
      to: this.cfg.treasuryAddr,
    });
    // Sign the smart-account auth entries with the executor session key, then send.
    await tx.signAuthEntries({
      address: this.cfg.treasuryAddr,
      authorizeEntry: this.signer.signAuthEntry,
    });
    const sent = await tx.signAndSend({ signTransaction: this.signer.signTransaction });
    return { txHash: sent.sendTransactionResponse?.hash ?? "" };
  }

  async markExecuted(id: number): Promise<{ txHash: string }> {
    const c = await this.client(this.cfg.govVaultId);
    const tx = await (
      c as unknown as {
        mark_executed: (a: { id: number }) => Promise<{
          signAndSend(o: unknown): Promise<{ sendTransactionResponse?: { hash: string } }>;
        }>;
      }
    ).mark_executed({ id });
    const sent = await tx.signAndSend({ signTransaction: this.signer.signTransaction });
    return { txHash: sent.sendTransactionResponse?.hash ?? "" };
  }
}
