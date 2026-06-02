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

export function buildRevealArgs(
  _proposalId: number,
  _sealedVotes: SealedVoteCiphertext[],
  _drand?: DrandConfig,
): Promise<RevealArgs> {
  void (null as unknown as VoteDecryption);
  throw new Error("buildRevealArgs: implemented in M5");
}
