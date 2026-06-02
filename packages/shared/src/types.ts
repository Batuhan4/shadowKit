// packages/shared/src/types.ts — foundation §3.1 / §5

export type ProposalStatus = "Open" | "Tallying" | "Approved" | "Rejected" | "Executed";

export interface ActionSpec {
  kind: "swap";
  assetIn: string;
  assetOut: string;
  amount: string;
  minOut: string;
}

export interface ProposalView {
  id: number;
  actionSpec: ActionSpec;
  cap: string;
  deadline: number;
  votesCast: number;
  status: ProposalStatus;
  weightedYes: string | null;
  weightedNo: string | null;
}

export type AgentLogPhase = "reveal" | "data" | "plan" | "sign" | "submit" | "done" | "error";

export interface AgentLog {
  ts: number;
  phase: AgentLogPhase;
  message: string;
  txHash?: string;
}

export interface SealedVoteCiphertext {
  round: number;
  ciphertext: string;
  sealedCommitmentHash: string;
}

export interface PublicSignals {
  merkleRoot: string;
  nullifier: string;
  proposalId: string;
  sealedCommitmentHash: string;
}

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: "groth16";
  curve: "bls12381";
}

export interface VoteDecryption {
  direction: 0 | 1;
  weight: string;
  sealedCommitmentHash: string;
}

export interface RevealArgs {
  proposalId: number;
  revealedYesW: string;
  revealedNoW: string;
  decryptions: VoteDecryption[];
}

/**
 * snarkjs decimal field string -> 32-byte big-endian hex (for Bls12381Fr / contract args).
 * foundation §3.1. Pure BigInt math (no external API).
 */
export function fieldToBe32Hex(decimal: string): string {
  if (!/^\d+$/.test(decimal)) {
    throw new Error(`fieldToBe32Hex: not a decimal field string: ${decimal}`);
  }
  const n = BigInt(decimal);
  if (n < 0n) throw new Error("fieldToBe32Hex: negative");
  const hex = n.toString(16);
  if (hex.length > 64) {
    throw new Error(`fieldToBe32Hex: value exceeds 32 bytes (${hex.length / 2} bytes)`);
  }
  return "0x" + hex.padStart(64, "0");
}

/** Convert a SealedVoteCiphertext to the XDR/native shape for the GovVault binding.
 *  Requires generated bindings (M5) — declared here for the binding surface; not used in M0.
 *  INTENTIONALLY-DEFERRED to M5 (spec §9 milestone map): throws a documented error and is
 *  covered by a negative test (types.test.ts) asserting it throws. NOT an untested public fn. */
export function toScSealedVote(_v: SealedVoteCiphertext): unknown {
  throw new Error("toScSealedVote: implemented in M5 (needs generated GovVault bindings)");
}
