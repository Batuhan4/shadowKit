import { describe, it, expect } from "vitest";
import { timelockSealVote } from "@shadowkit/zk-prover";
import { revealTally, buildRevealArgs } from "../src/index.js";
import { timelockUnsealVote } from "@shadowkit/zk-prover";

const PAST = 1692803367 + 5 * 3; // released round -> decryptable now
// Foundation §3.1: sealedCommitmentHash is a 32-byte (64-hex-char) 0x value.
const be32 = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const H_A = be32(0x0a), H_B = be32(0x0b), H_C = be32(0x0c);

describe("E2E sealed-vote -> reveal -> approve (REAL tlock, non-TDD integration smoke)", () => {
  it("seals 3 votes, stays sealed until opened, reveals weighted tally that passes quorum", async () => {
    // 1) SEAL (what the browser/client does at cast time)
    const v0 = await timelockSealVote(1, "100", PAST); v0.sealedCommitmentHash = H_A;
    const v1 = await timelockSealVote(1, "250", PAST); v1.sealedCommitmentHash = H_B;
    const v2 = await timelockSealVote(0, "300", PAST); v2.sealedCommitmentHash = H_C;
    const sealedOnChain = [v0, v1, v2];

    // 2) SEALED INVARIANT: the on-chain blob reveals nothing — only opaque base64 ciphertext.
    for (const v of sealedOnChain) {
      expect(v.ciphertext).not.toContain("100");
      expect(v.ciphertext).not.toContain("yes");
      expect(typeof v.round).toBe("number");
      expect(v.sealedCommitmentHash).toMatch(/^0x[0-9a-f]{64}$/); // §3.1 width
    }

    // 3) REVEAL (what tally-reveal / the agent does at close)
    const tally = await revealTally(sealedOnChain);
    expect(tally.yesW).toBe("350");
    expect(tally.noW).toBe("300");

    // 4) REVEAL ARGS for GovVault.close_and_reveal — ordered, commitment-bound
    const args = await buildRevealArgs(0, sealedOnChain);
    expect(args.decryptions.map((d) => d.sealedCommitmentHash)).toEqual([H_A, H_B, H_C]);
    expect(args.revealedYesW).toBe("350");

    // 5) QUORUM decision mirrors on-chain rule (yes>no AND voters>=3) -> approved
    const voters = sealedOnChain.length;
    const approved = BigInt(args.revealedYesW) > BigInt(args.revealedNoW) && voters >= 3;
    expect(approved).toBe(true);

    // 6) sanity: each ciphertext genuinely decrypts to its sealed values (REAL tlock round-trip)
    const open0 = await timelockUnsealVote(v0);
    expect(open0).toEqual({ direction: 1, weight: "100" });
  }, 180_000);

  // NEW invariant no unit covers: buildRevealArgs preserves on-chain SealedVotes ORDER under a
  // shuffle (decryptions[i] binds to sealedVotes[i] for the EXACT array passed). Genuine red→green:
  // fails against any reordering (e.g. Promise.all racing). This is the load-bearing index contract
  // close_and_reveal relies on (foundation §2.2 "same order as DataKey::SealedVotes(id)").
  it("preserves input order: decryptions[i] binds to sealedVotes[i] under a shuffled set", async () => {
    const a = await timelockSealVote(0, "5", PAST);   a.sealedCommitmentHash = be32(0xa1);
    const b = await timelockSealVote(1, "9", PAST);   b.sealedCommitmentHash = be32(0xb2);
    const c = await timelockSealVote(1, "7", PAST);   c.sealedCommitmentHash = be32(0xc3);
    // deliberately NOT in seal order:
    const shuffled = [c, a, b];
    const args = await buildRevealArgs(0, shuffled);
    // order must match the INPUT array exactly (index-aligned), not seal order or sorted:
    expect(args.decryptions.map((d) => d.sealedCommitmentHash)).toEqual([
      be32(0xc3), be32(0xa1), be32(0xb2),
    ]);
    expect(args.decryptions.map((d) => d.weight)).toEqual(["7", "5", "9"]);
    expect(args.decryptions.map((d) => d.direction)).toEqual([1, 0, 1]);
  }, 180_000);
});
