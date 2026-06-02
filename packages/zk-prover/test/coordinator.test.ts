import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { verifyAndAuthorize } from "../src/coordinator.js";
import { generateVoteProof } from "../src/index.js";
import { poseidonHashBls } from "../src/poseidon.js";

const ART = resolve(__dirname, "../artifacts");
const wasmPath = resolve(ART, "vote.wasm");
const zkeyPath = resolve(ART, "vote_final.zkey");
const vkey = JSON.parse(readFileSync(resolve(ART, "verification_key.json"), "utf8"));

async function buildInput() {
  const DEPTH = 20, secret = "12345", weight = "1000", proposalId = "0", direction = 1 as const;
  const secretCommit = await poseidonHashBls([secret]);
  const leaf = await poseidonHashBls([secretCommit, weight]);
  const zero = ["0"]; for (let i=1;i<=DEPTH;i++) zero.push(await poseidonHashBls([zero[i-1], zero[i-1]]));
  const merklePath: string[] = [], pathIndices: number[] = [];
  let cur = leaf; for (let i=0;i<DEPTH;i++){ merklePath.push(zero[i]); pathIndices.push(0); cur = await poseidonHashBls([cur, zero[i]]); }
  return { secret, merklePath, pathIndices, weight, proposalId, direction, merkleRoot: cur };
}

describe("off-chain coordinator (verifyAndAuthorize)", () => {
  it("authorizes a VALID proof (verified === true)", async () => {
    const r = await generateVoteProof(await buildInput(), { wasmPath, zkeyPath }, 1_999_999_999);
    const decision = await verifyAndAuthorize(vkey, r.publicSignals, r.proof);
    expect(decision.verified).toBe(true);
  });

  it("REFUSES a TAMPERED proof off-chain (verified === false) — no authorization", async () => {
    const r = await generateVoteProof(await buildInput(), { wasmPath, zkeyPath }, 1_999_999_999);
    // Mutate pi_a so the pairing check fails; snarkjs.groth16.verify must return false.
    const bad = { ...r.proof, pi_a: ["1", "2", "1"] as [string, string, string] };
    const decision = await verifyAndAuthorize(vkey, r.publicSignals, bad);
    expect(decision.verified).toBe(false);
  });

  it("REFUSES wrong public signals off-chain (verified === false)", async () => {
    const r = await generateVoteProof(await buildInput(), { wasmPath, zkeyPath }, 1_999_999_999);
    const badSignals = { ...r.publicSignals, nullifier: "42" };
    const decision = await verifyAndAuthorize(vkey, badSignals, r.proof);
    expect(decision.verified).toBe(false);
  });
});
