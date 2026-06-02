// packages/tally-reveal/src/index.ts — @shadowkit/tally-reveal (foundation §3.4).
import type { SealedVoteCiphertext, RevealArgs, VoteDecryption } from "@shadowkit/shared";
import { timelockUnsealVote, type DrandConfig } from "@shadowkit/zk-prover";

export { roundForDeadline } from "./drand.js";

/** At close: tlock-decrypt every sealed vote (REAL tlock-js), sum weighted yes/no.
 *  decrypted[i] corresponds to sealedVotes[i] (SAME order the chain stores them).
 *  A not-yet-released vote throws the real tlock "too early" error (propagated — no partial tally). */
export async function revealTally(
  sealedVotes: SealedVoteCiphertext[],
  drand?: DrandConfig,
): Promise<{ yesW: string; noW: string; decrypted: Array<{ direction: 0 | 1; weight: string }> }> {
  const decrypted: Array<{ direction: 0 | 1; weight: string }> = [];
  let yes = 0n;
  let no = 0n;
  for (const v of sealedVotes) {
    const { direction, weight } = await timelockUnsealVote(v, drand);
    decrypted.push({ direction, weight });
    const w = BigInt(weight);
    if (direction === 1) yes += w;
    else no += w;
  }
  return { yesW: yes.toString(), noW: no.toString(), decrypted };
}

/** Build GovVault.close_and_reveal args. ONE VoteDecryption per sealed vote, SAME order
 *  as DataKey::SealedVotes(id); each carries its sealedCommitmentHash so the chain binds it
 *  to the stored ciphertext, then re-aggregates (foundation §2.2, §3.4). */
export async function buildRevealArgs(
  proposalId: number,
  sealedVotes: SealedVoteCiphertext[],
  drand?: DrandConfig,
): Promise<RevealArgs> {
  const { yesW, noW, decrypted } = await revealTally(sealedVotes, drand);
  const decryptions: VoteDecryption[] = decrypted.map((d, i) => ({
    direction: d.direction,
    weight: d.weight,
    sealedCommitmentHash: sealedVotes[i]!.sealedCommitmentHash,
  }));
  return { proposalId, revealedYesW: yesW, revealedNoW: noW, decryptions };
}
