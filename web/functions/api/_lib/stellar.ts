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
import {
  contract,
  Keypair,
  Contract,
  TransactionBuilder,
  Address,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  rpc,
} from "@stellar/stellar-sdk";

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

/** Tops up the treasury's input asset so each (repeatable) demo run has funds to swap. Each swap
 *  drains the treasury's assetIn, so without a top-up a second run would fail on an empty balance. */
export interface Funder {
  /** Mint `(target - current)` of `tokenId` to `to` when current < target. No-op (txHash "") if
   *  already funded. Returns the current balance after any mint. */
  ensureFunds(args: {
    tokenId: string;
    to: string;
    target: string;
  }): Promise<{ minted: string; balance: string; txHash: string }>;
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

/** REAL funder: mints the treasury's input-asset shortfall via the USDC SAC `mint` (admin-auth).
 *  Signed by the SAC admin key (the deployer/ADMIN_SECRET) so each repeatable run is genuinely funded
 *  on-chain (no mock). On testnet our USDC SAC admin == the deployer that also admin-signs proposals.
 *
 *  Uses the low-level Contract.call + simulate/prepare/submit path (the PROVEN create-proposal.ts
 *  pattern) instead of contract.Client.from: the high-level Client.from chokes on the built-in SAC's
 *  contract instance entry under nodejs_compat (Opaque XDR write trap on getLedgerEntries). */
export class StellarFunder implements Funder {
  private admin: Keypair;
  constructor(
    private cfg: Pick<ChainCfg, "rpcUrl" | "networkPassphrase">,
    adminSecret: string,
  ) {
    this.admin = Keypair.fromSecret(adminSecret);
  }

  private server(): rpc.Server {
    return new rpc.Server(this.cfg.rpcUrl, { allowHttp: this.cfg.rpcUrl.startsWith("http://") });
  }

  /** Read a SEP-41/SAC token `balance(addr)` via a read-only simulate (returns i128 as bigint). */
  private async balanceOf(server: rpc.Server, tokenId: string, addr: string): Promise<bigint> {
    try {
      const c = new Contract(tokenId);
      const account = await server.getAccount(this.admin.publicKey());
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.cfg.networkPassphrase,
      })
        .addOperation(c.call("balance", new Address(addr).toScVal()))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim) || !sim.result) return 0n;
      const v = scValToNative(sim.result.retval) as bigint | number | string | undefined;
      return v !== undefined && v !== null ? BigInt(String(v)) : 0n;
    } catch {
      return 0n; // missing trustline / not yet funded reads as zero
    }
  }

  async ensureFunds(args: {
    tokenId: string;
    to: string;
    target: string;
  }): Promise<{ minted: string; balance: string; txHash: string }> {
    const server = this.server();
    const target = BigInt(args.target);
    const current = await this.balanceOf(server, args.tokenId, args.to);
    if (current >= target) {
      return { minted: "0", balance: current.toString(), txHash: "" };
    }
    const shortfall = target - current;
    // mint(to: Address, amount: i128) — admin.require_auth() satisfied by the source signature.
    const c = new Contract(args.tokenId);
    const account = await server.getAccount(this.admin.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        c.call(
          "mint",
          new Address(args.to).toScVal(),
          nativeToScVal(shortfall, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(this.admin);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`mint sendTransaction ERROR: ${JSON.stringify(sent.errorResult ?? sent)}`);
    }
    const hash = sent.hash;
    for (let i = 0; i < 20; i++) {
      const res = await server.getTransaction(hash);
      if (res.status === "SUCCESS") break;
      if (res.status === "FAILED") {
        throw new Error(`mint tx FAILED: ${hash}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const balance = await this.balanceOf(server, args.tokenId, args.to);
    return { minted: shortfall.toString(), balance: balance.toString(), txHash: hash };
  }
}
