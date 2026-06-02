// OFF-CHAIN VERIFY coordinator (foundation §2.1 fallback). Runs the REAL snarkjs.groth16.verify and
// returns the `verified` flag the on-chain `cast_vote` (feature = "offchain-verify") consumes. The
// coordinator MUST refuse to authorize (verified === false) any proof that does not verify — this is
// the actual off-chain verification the fallback exists for (charter rule 3). NO faked success.
import type { Groth16Proof, PublicSignals } from "@shadowkit/shared";
import { verifyVoteProof } from "./index.js";

export interface AuthorizationDecision {
  verified: boolean; // -> the `verified: bool` arg of GovVault.cast_vote under offchain-verify
}

/** Pre-verify the proof off-chain. Returns { verified: true } ONLY when snarkjs accepts it.
 *  A trusted-coordinator deployment then submits cast_vote(..., verified) under its own auth. */
export async function verifyAndAuthorize(
  vkey: object, publicSignals: PublicSignals, proof: Groth16Proof,
): Promise<AuthorizationDecision> {
  const verified = await verifyVoteProof(vkey, publicSignals, proof);
  return { verified };
}
