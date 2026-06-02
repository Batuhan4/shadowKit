// Provider gate for the SELL side. The actual on-chain read is injected (readApproved) so the gate
// logic is unit-testable; src/server.ts wires the real GovVault binding client (foundation §1 bindings).
export class ProposalNotApprovedError extends Error {
  constructor(id: number) {
    super(`proposal ${id} is not approved`);
    this.name = "ProposalNotApprovedError";
  }
}

/** Throw unless GovVault.is_approved(id) is true. */
export async function assertApproved(
  proposalId: number,
  readApproved: (id: number) => Promise<boolean>,
): Promise<void> {
  const ok = await readApproved(proposalId);
  if (!ok) throw new ProposalNotApprovedError(proposalId);
}
