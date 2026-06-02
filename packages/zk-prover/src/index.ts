import * as snarkjs from "snarkjs";
import type { Groth16Proof, PublicSignals, SealedVoteCiphertext } from "@shadowkit/shared";
import { poseidonHashBls } from "./poseidon.js";
import { timelockSealVote, type DrandConfig } from "./seal.js";
export type { DrandConfig } from "./seal.js";
// M5 re-exports so consumers (e.g. @shadowkit/tally-reveal) can import the seal/round helpers.
export { timelockSealVote, timelockUnsealVote, roundForDeadline } from "./seal.js";
export { DEFAULT_DRAND } from "./drandConfig.js";

export interface VoteInput {
  secret: string; merklePath: string[]; pathIndices: number[];
  weight: string; proposalId: string; direction: 0 | 1; merkleRoot: string;
}
export interface VoteProofResult {
  proof: Groth16Proof;
  publicSignals: PublicSignals; // [merkleRoot, nullifier, proposalId, sealedCommitmentHash]
  sealedCiphertext: SealedVoteCiphertext;
}

/** nullifier = Poseidon(secret, proposalId) over BLS12-381 (matches vote.circom constraint #3). */
export async function nullifierFor(secret: string, proposalId: string): Promise<string> {
  return poseidonHashBls([secret, proposalId]);
}

export async function generateVoteProof(
  input: VoteInput,
  artifacts: { wasmPath: string; zkeyPath: string },
  deadlineUnixSeconds: number,
  drand?: DrandConfig,
): Promise<VoteProofResult> {
  if (!input.merklePath?.length) throw new Error("generateVoteProof: empty merklePath");
  if (input.merklePath.length !== input.pathIndices.length) throw new Error("path/index length mismatch");
  // Seal the vote (foundation §3.2). timelockSealVote returns the `sealKey` so the circuit's private
  // `sealKey` input matches the sealedCommitmentHash it produced (M4: deterministic; M5: tlock + random).
  const sealed = await timelockSealVote(input.direction, input.weight, deadlineUnixSeconds, drand);
  const sealKey = sealed.sealKey;
  const sealedCommitmentDecimal = BigInt(sealed.sealedCommitmentHash).toString();

  const circuitInput = {
    merkleRoot: input.merkleRoot,
    proposalId: input.proposalId,
    sealedCommitmentHash: sealedCommitmentDecimal,
    secret: input.secret,
    weight: input.weight,
    direction: String(input.direction),
    pathElements: input.merklePath,
    pathIndices: input.pathIndices.map(String),
    sealKey,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, artifacts.wasmPath, artifacts.zkeyPath);
  // snarkjs native order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash] (Task 4.10).
  // Re-map to the BINDING external order.
  const signals: PublicSignals = {
    nullifier: publicSignals[0]!,
    merkleRoot: publicSignals[1]!,
    proposalId: publicSignals[2]!,
    sealedCommitmentHash: publicSignals[3]!,
  };
  // Strip the circuit-only `sealKey` from the returned ciphertext envelope (it is a private input,
  // never stored on-chain). `sealedCiphertext` is exactly the foundation §3.1 SealedVoteCiphertext.
  // A4 BINDING: stamp the commitment hash from the PROOF's 4th public signal so the on-chain
  // SealedVote.sealed_commitment_hash == pub_signals[3] exactly (same value, same representation).
  const sealedCiphertext: SealedVoteCiphertext = {
    round: sealed.round,
    ciphertext: sealed.ciphertext,
    sealedCommitmentHash: signals.sealedCommitmentHash,
  };
  return { proof: proof as Groth16Proof, publicSignals: signals, sealedCiphertext };
}

export async function verifyVoteProof(
  vkey: object, publicSignals: PublicSignals, proof: Groth16Proof,
): Promise<boolean> {
  // snarkjs.verify expects the NATIVE order array [nullifier, merkleRoot, proposalId, sealedCommitmentHash].
  const native = [publicSignals.nullifier, publicSignals.merkleRoot, publicSignals.proposalId, publicSignals.sealedCommitmentHash];
  return snarkjs.groth16.verify(vkey, native, proof as any);
}
