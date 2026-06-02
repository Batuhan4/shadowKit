import { describe, it, expect } from "vitest";
import { timelockSealVote } from "@shadowkit/zk-prover";
import { revealTally } from "../src/index.js";
import type { SealedVoteCiphertext } from "@shadowkit/shared";

const PAST_DEADLINE = 1692803367 + 5 * 3; // round ~6, released → decryptable now

async function seal(dir: 0 | 1, w: string): Promise<SealedVoteCiphertext> {
  return timelockSealVote(dir, w, PAST_DEADLINE);
}

describe("revealTally (REAL tlock decryption + weighted sum)", () => {
  it("sums weight by direction over decrypted votes", async () => {
    const votes = await Promise.all([
      seal(1, "100"), // yes 100
      seal(1, "250"), // yes 250
      seal(0, "300"), // no 300
    ]);
    const res = await revealTally(votes);
    expect(res.yesW).toBe("350");
    expect(res.noW).toBe("300");
    expect(res.decrypted).toHaveLength(3);
    expect(res.decrypted[0]).toEqual({ direction: 1, weight: "100" });
  }, 120_000);
});

import { buildRevealArgs } from "../src/index.js";

// Foundation §3.1: SealedVoteCiphertext.sealedCommitmentHash is "hex 0x.. 32 bytes; == publicSignals[3]"
// and at the contract boundary it converts to BytesN<32>. Test fixtures MUST be well-formed
// 32-byte (64-hex-char) 0x-prefixed values, NOT 1-byte stubs — a malformed width can pass
// off-chain yet hide a real BytesN<32> serialization mismatch.
const be32 = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const HASH_A = be32(0xaa); // 0x0000...00aa  (64 hex chars)
const HASH_B = be32(0xbb);

describe("buildRevealArgs (RevealArgs shape + commitment binding + order)", () => {
  it("emits one VoteDecryption per sealed vote, in order, carrying its 32-byte commitment hash", async () => {
    const v0 = await seal(1, "10"); v0.sealedCommitmentHash = HASH_A;
    const v1 = await seal(0, "20"); v1.sealedCommitmentHash = HASH_B;
    // honor the §3.1 width contract explicitly
    expect(HASH_A).toMatch(/^0x[0-9a-f]{64}$/);
    expect(HASH_B).toMatch(/^0x[0-9a-f]{64}$/);
    const args = await buildRevealArgs(7, [v0, v1]);
    expect(args.proposalId).toBe(7);
    expect(args.revealedYesW).toBe("10");
    expect(args.revealedNoW).toBe("20");
    expect(args.decryptions).toHaveLength(2);
    // order preserved + each decryption bound to its ciphertext commitment
    expect(args.decryptions[0]).toEqual({ direction: 1, weight: "10", sealedCommitmentHash: HASH_A });
    expect(args.decryptions[1]).toEqual({ direction: 0, weight: "20", sealedCommitmentHash: HASH_B });
  }, 120_000);
});
