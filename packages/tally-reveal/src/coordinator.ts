// packages/tally-reveal/src/coordinator.ts
// D6 FALLBACK (spec §13): coordinator commit-reveal. REAL sha256 commitments (Node crypto).
import { createHash } from "node:crypto";
import type { RevealArgs } from "@shadowkit/shared";

export interface CommittedVote {
  direction: 0 | 1;
  weight: string;      // i128 decimal
  salt: string;
  commitment: string;  // 0x.. sha256(direction|weight|salt)
}

function commit(direction: 0 | 1, weight: string, salt: string): string {
  const h = createHash("sha256").update(`${direction}|${weight}|${salt}`, "utf-8").digest("hex");
  return `0x${h}`;
}

/** Commit phase: bind a vote to an opaque hash the voter can later open. */
export function commitVote(direction: 0 | 1, weight: string, salt: string): CommittedVote {
  return { direction, weight, salt, commitment: commit(direction, weight, salt) };
}

/** Reveal phase: verify each opening against its commitment, aggregate weighted yes/no.
 *  Returns RevealArgs with EMPTY decryptions (the on-chain coordinator-reveal feature trusts
 *  the aggregate; foundation §2.2 fallback ladder). Throws on any commitment mismatch. */
export function coordinatorReveal(proposalId: number, votes: CommittedVote[]): RevealArgs {
  let yes = 0n, no = 0n;
  for (const v of votes) {
    if (commit(v.direction, v.weight, v.salt) !== v.commitment) {
      throw new Error(`coordinator reveal: commitment mismatch for weight ${v.weight}`);
    }
    const w = BigInt(v.weight);
    if (v.direction === 1) yes += w; else no += w;
  }
  return { proposalId, revealedYesW: yes.toString(), revealedNoW: no.toString(), decryptions: [] };
}
