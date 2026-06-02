import { describe, it, expect } from "vitest";
import { assertApproved } from "../src/gating.js";

// Provider gate: assertApproved reads GovVault.is_approved via the binding client. We inject a
// fake readApproved fn (the network boundary) but the GATE LOGIC under test is real (throws/passes).
describe("assertApproved (provider gate)", () => {
  it("passes when GovVault reports approved", async () => {
    await expect(assertApproved(7, async () => true)).resolves.toBeUndefined();
  });
  it("throws ProposalNotApproved when GovVault reports not approved", async () => {
    await expect(assertApproved(7, async () => false)).rejects.toThrow(/not approved/i);
  });
});
