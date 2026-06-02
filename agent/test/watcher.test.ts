import { describe, it, expect, vi } from "vitest";
import type { ProposalStatus } from "@shadowkit/shared";

// Mock ONLY the stellar-sdk transport surface the REAL Watcher.readStatus uses
// (rpc.Server + contract.Client.from). Everything else is the actual SDK. The real
// readStatus path (build the client, call proposal(id), project .status) runs for real;
// only the network boundary is stubbed. (Charter rule 1/4 — interface/transport seam.)
// vi.hoisted lets the hoisted vi.mock factory reference these spies.
const { proposalMock, clientFromMock } = vi.hoisted(() => {
  const proposalMock = vi.fn(async (_args: { id: number }) => ({ result: { status: "Approved" as ProposalStatus } }));
  const clientFromMock = vi.fn(async () => ({ proposal: proposalMock }));
  return { proposalMock, clientFromMock };
});

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: { ...actual.rpc, Server: class FakeServer {
      constructor(public url: string, public opts?: unknown) {}
    } },
    contract: { ...actual.contract, Client: { ...actual.contract.Client, from: clientFromMock } },
  };
});

import { Watcher } from "../src/watcher";

describe("Watcher", () => {
  it("polling loop resolves once status becomes Approved", async () => {
    const statuses: ProposalStatus[] = ["Open", "Open", "Approved"];
    let i = 0;
    // Inject ONLY the RpcReader boundary (a small interface), NOT the whole method.
    const reader = { readProposalStatus: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]!) };
    const w = new Watcher({ rpcUrl: "http://x", govVaultId: "CGOV", networkPassphrase: "Test" }, reader);
    await w.waitForApproved(0, 1);
    expect(reader.readProposalStatus).toHaveBeenCalledTimes(3);
  });

  it("REAL readStatus invokes the GovVault client and decodes status (RPC transport mocked)", async () => {
    // The real Watcher builds a contract.Client (contract.Client.from) and performs a read-only
    // invoke; the transport mock returns a simulated ProposalView with status "Approved" so the
    // REAL client/decode path runs and yields "Approved".
    const w = new Watcher({ rpcUrl: "http://rpc", govVaultId: "CGOV", networkPassphrase: "Test" });
    const status = await (w as unknown as { readStatus(id: number): Promise<ProposalStatus> }).readStatus(0);
    expect(status).toBe("Approved");
    expect(clientFromMock).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "CGOV", networkPassphrase: "Test", rpcUrl: "http://rpc" }),
    );
    expect(proposalMock).toHaveBeenCalledWith({ id: 0 });
  });
});
