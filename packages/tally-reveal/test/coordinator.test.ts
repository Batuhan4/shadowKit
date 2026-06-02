import { describe, it, expect } from "vitest";
import { commitVote, coordinatorReveal, type CommittedVote } from "../src/coordinator.js";

describe("coordinator commit-reveal fallback (REAL sha256)", () => {
  it("commit hides the vote; reveal opens it and aggregates", () => {
    const c0 = commitVote(1, "100", "salt-a"); // yes 100
    const c1 = commitVote(1, "250", "salt-b"); // yes 250
    const c2 = commitVote(0, "300", "salt-c"); // no 300
    // commitment is a hash, not the plaintext
    expect(c0.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c0.commitment).not.toContain("100");

    const args = coordinatorReveal(7, [c0, c1, c2]);
    expect(args.proposalId).toBe(7);
    expect(args.revealedYesW).toBe("350");
    expect(args.revealedNoW).toBe("300");
    // coordinator mode submits NO per-vote decryptions on-chain (the chain trusts the aggregate)
    expect(args.decryptions).toEqual([]);
  });

  it("detects a tampered reveal (commitment mismatch throws)", () => {
    const c: CommittedVote = commitVote(1, "100", "salt");
    const tampered: CommittedVote = { ...c, weight: "999" }; // lie about weight, keep old commitment
    expect(() => coordinatorReveal(1, [tampered])).toThrow(/commitment mismatch/i);
  });
});

describe("coordinator-mode integration bridge (off-chain aggregate == on-chain args)", () => {
  it("coordinatorReveal yields the exact (yes,no) the on-chain coordinator-reveal will accept", () => {
    // off-chain commit phase (what each voter submits to the coordinator)
    const committed = [
      commitVote(1, "400", "s0"), // yes 400
      commitVote(1, "300", "s1"), // yes 300
      commitVote(0, "100", "s2"), // no 100
    ];
    // off-chain reveal phase -> RevealArgs (empty decryptions: chain trusts the aggregate)
    const args = coordinatorReveal(42, committed);
    expect(args.revealedYesW).toBe("700");
    expect(args.revealedNoW).toBe("100");
    expect(args.decryptions).toEqual([]);
    // These EXACT i128 strings are what the contract test (D3.2) passes to close_and_reveal
    // under --features coordinator-reveal; quorum: 700 > 100 AND voters(3) >= 3 -> Approved.
    expect(BigInt(args.revealedYesW) > BigInt(args.revealedNoW)).toBe(true);
  });
});
