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

// --- M5 fallback re-exports + REVEAL_MODE selector (spec §13.2 ladder) ---
import { aggregateUnlinked, aggregate1p1v } from "./degrade.js";
export { aggregateUnlinked, aggregate1p1v } from "./degrade.js";
export { commitVote, coordinatorReveal, type CommittedVote } from "./coordinator.js";

export type RevealMode = "timelock" | "weight-unlinked" | "1p1v";

/** Config-selectable reveal. `timelock` = PRIMARY (weighted, with per-vote decryptions for
 *  on-chain re-aggregation). `weight-unlinked`/`1p1v` = degradation fallbacks (head-count,
 *  empty decryptions -> use the on-chain coordinator-reveal feature). spec §13.2 ladder. */
export async function buildRevealArgsForMode(
  mode: RevealMode,
  proposalId: number,
  sealedVotes: SealedVoteCiphertext[],
  drand?: DrandConfig,
): Promise<RevealArgs> {
  if (mode === "timelock") return buildRevealArgs(proposalId, sealedVotes, drand);
  const { decrypted } = await revealTally(sealedVotes, drand);
  const agg = mode === "weight-unlinked" ? aggregateUnlinked(decrypted) : aggregate1p1v(decrypted);
  return { proposalId, revealedYesW: agg.yesW, revealedNoW: agg.noW, decryptions: [] };
}
