// @shadowkit/tally-reveal — STUB (foundation §3.4). Real impl: M5.
import type { SealedVoteCiphertext, RevealArgs } from "@shadowkit/shared";
import type { DrandConfig } from "@shadowkit/zk-prover";

export function revealTally(
  _sealedVotes: SealedVoteCiphertext[],
  _drand?: DrandConfig,
): Promise<{ yesW: string; noW: string; decrypted: Array<{ direction: 0 | 1; weight: string }> }> {
  throw new Error("revealTally: implemented in M5");
}
export function buildRevealArgs(
  _proposalId: number,
  _sealedVotes: SealedVoteCiphertext[],
  _drand?: DrandConfig,
): Promise<RevealArgs> {
  throw new Error("buildRevealArgs: implemented in M5");
}
