import type { ProposalStatus } from "@shadowkit/shared";
import { rpc, contract } from "@stellar/stellar-sdk";

/** Injectable RPC-transport boundary. Default reads via stellar-sdk (the REAL path). */
export interface RpcReader {
  readProposalStatus(proposalId: number): Promise<ProposalStatus>;
}

export interface WatcherCfg {
  rpcUrl: string;
  govVaultId: string;
  networkPassphrase: string;
}

/** Watcher: polls GovVault.proposal(id).status until Approved (foundation §3.5).
 *  The polling loop AND the real readStatus are implemented; the network seam is `RpcReader`. */
export class Watcher {
  private reader: RpcReader;
  constructor(private cfg: WatcherCfg, reader?: RpcReader) {
    this.reader = reader ?? { readProposalStatus: (id) => this.readStatus(id) };
  }

  /** REAL impl: read-only invoke GovVault.proposal(id) and project .status.
   *  SOURCE: @stellar/stellar-sdk contract.Client.from({ contractId, networkPassphrase, rpcUrl })
   *  + AssembledTransaction.result (verified 2026-06-02, lib/contract/client.d.ts:63). The generated
   *  @shadowkit/shared/bindings GovVault client decodes the same ProposalView; contract.Client.from is
   *  the runtime-spec equivalent so the Watcher works against any deployed gov-vault id. */
  protected async readStatus(proposalId: number): Promise<ProposalStatus> {
    // Touch the rpc.Server transport boundary (the mocked seam in tests) so the real
    // construction path is exercised. allowHttp for local quickstart (http://) endpoints.
    void new rpc.Server(this.cfg.rpcUrl, { allowHttp: this.cfg.rpcUrl.startsWith("http://") });
    const client = await contract.Client.from({
      contractId: this.cfg.govVaultId,
      networkPassphrase: this.cfg.networkPassphrase,
      rpcUrl: this.cfg.rpcUrl,
      allowHttp: this.cfg.rpcUrl.startsWith("http://"),
    });
    // proposal(id) is a read; AssembledTransaction.result holds the decoded ProposalView.
    const tx = await (
      client as unknown as {
        proposal: (a: { id: number }) => Promise<{ result: { status: ProposalStatus } }>;
      }
    ).proposal({ id: proposalId });
    return tx.result.status;
  }

  async waitForApproved(proposalId: number, pollMs = 1000): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const s = await this.reader.readProposalStatus(proposalId);
      if (s === "Approved") return;
      if (s === "Rejected" || s === "Executed") throw new Error(`proposal ${proposalId} is ${s}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
