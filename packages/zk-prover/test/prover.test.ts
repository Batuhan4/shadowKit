import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { generateVoteProof, verifyVoteProof, nullifierFor } from "../src/index.js";
import { poseidonHashBls } from "../src/poseidon.js";

const ART = resolve(__dirname, "../artifacts");
const wasmPath = resolve(ART, "vote.wasm");
const zkeyPath = resolve(ART, "vote_final.zkey");
const vkey = JSON.parse(readFileSync(resolve(ART, "verification_key.json"), "utf8"));

// Build a valid single-voter input the same way make-input.mjs did (depth 20, voter at index 0).
async function buildInput() {
  const DEPTH = 20, secret = "12345", weight = "1000", proposalId = "0", direction = 1 as const, sealKey = "987654321";
  const secretCommit = await poseidonHashBls([secret]);
  const leaf = await poseidonHashBls([secretCommit, weight]);
  const zero = ["0"]; for (let i=1;i<=DEPTH;i++) zero.push(await poseidonHashBls([zero[i-1]!, zero[i-1]!]));
  const merklePath: string[] = [], pathIndices: number[] = [];
  let cur = leaf; for (let i=0;i<DEPTH;i++){ merklePath.push(zero[i]!); pathIndices.push(0); cur = await poseidonHashBls([cur, zero[i]!]); }
  void sealKey; void weight; void proposalId; void direction;
  return { secret, merklePath, pathIndices, weight, proposalId, direction, merkleRoot: cur };
}

describe("generateVoteProof", () => {
  it("produces a proof that verifies, with BINDING public-signal order", async () => {
    const input = await buildInput();
    const r = await generateVoteProof(input, { wasmPath, zkeyPath }, 1_999_999_999);
    // BINDING order: [merkleRoot, nullifier, proposalId, sealedCommitmentHash].
    expect(r.publicSignals.merkleRoot).toBe(input.merkleRoot);
    expect(r.publicSignals.proposalId).toBe("0");
    expect(r.publicSignals.nullifier).toBe(await nullifierFor("12345", "0"));
    expect(await verifyVoteProof(vkey, r.publicSignals, r.proof)).toBe(true);
  });

  it("nullifierFor = Poseidon(secret, proposalId) (BLS field)", async () => {
    expect(await nullifierFor("12345", "0")).toBe(await poseidonHashBls(["12345", "0"]));
  });

  it("rejects malformed input (missing path)", async () => {
    const input = await buildInput();
    // @ts-expect-error intentional bad input
    await expect(generateVoteProof({ ...input, merklePath: [] }, { wasmPath, zkeyPath }, 1)).rejects.toThrow();
  });
});

// NEGATIVE tests for the public off-chain verifier (charter rule 1; foundation §3.2 — verifyVoteProof
// is the off-chain twin of the on-chain verifier and the off-chain-verify fallback depends on it).
describe("verifyVoteProof (negative)", () => {
  it("returns false for a TAMPERED proof (mutated pi_a)", async () => {
    const r = await generateVoteProof(await buildInput(), { wasmPath, zkeyPath }, 1_999_999_999);
    // Replace pi_a with a different (valid-shaped) point => pairing check fails => false.
    const bad = { ...r.proof, pi_a: ["1", "2", "1"] as [string, string, string] };
    expect(await verifyVoteProof(vkey, r.publicSignals, bad)).toBe(false);
  });

  it("returns false for WRONG public signals (mutated nullifier)", async () => {
    const r = await generateVoteProof(await buildInput(), { wasmPath, zkeyPath }, 1_999_999_999);
    // This also exercises the snarkjs native-order re-map under failure (binding->native mapping).
    const badSignals = { ...r.publicSignals, nullifier: "42" };
    expect(await verifyVoteProof(vkey, badSignals, r.proof)).toBe(false);
  });
});
