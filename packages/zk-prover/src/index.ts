// @shadowkit/zk-prover — STUB (foundation §3.2). Real impl: M4 (proof) + M5 (seal).
import type { Groth16Proof, PublicSignals, SealedVoteCiphertext } from "@shadowkit/shared";

export interface VoteInput {
  secret: string;
  merklePath: string[];
  pathIndices: number[];
  weight: string;
  proposalId: string;
  direction: 0 | 1;
  merkleRoot: string;
}
export interface VoteProofResult {
  proof: Groth16Proof;
  publicSignals: PublicSignals;
  sealedCiphertext: SealedVoteCiphertext;
}
export interface DrandConfig {
  chainUrl: string;
  chainHash: string;
}

export function generateVoteProof(
  _input: VoteInput,
  _artifacts: { wasmPath: string; zkeyPath: string },
  _deadlineUnixSeconds: number,
  _drand?: DrandConfig,
): Promise<VoteProofResult> {
  throw new Error("generateVoteProof: implemented in M4/M5");
}
export function verifyVoteProof(
  _vkey: object,
  _publicSignals: PublicSignals,
  _proof: Groth16Proof,
): Promise<boolean> {
  throw new Error("verifyVoteProof: implemented in M4");
}
export function nullifierFor(_secret: string, _proposalId: string): string {
  throw new Error("nullifierFor: implemented in M4");
}
