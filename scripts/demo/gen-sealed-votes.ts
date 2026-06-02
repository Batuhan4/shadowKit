// scripts/demo/gen-sealed-votes.ts — generate N REAL sealed votes for the SEALED-ZK demo.
//
// For a 3-holder snapshot it:
//   1) builds the Poseidon Merkle snapshot (secretCommit = Poseidon(secret), leaf = Poseidon(sc,weight))
//   2) for each holder, runs the REAL Groth16 prover (snarkjs.fullProve over vote.wasm/vote_final.zkey)
//      and the REAL tlock seal (timelockSealVote -> drand quicknet round at the deadline)
//   3) marshals each proof to the on-chain Proof bytes (proof-marshal.mjs, on-chain-verified layout)
//   4) emits a JSON manifest the demo shell drives `stellar contract invoke cast_vote` from, PLUS the
//      snapshot root (BINDING: gov-vault must be init'd with this exact merkle_root).
//
// Output (stdout, single JSON line): { root, rootBe32Hex, deadline, votes: [{ proof, pubSignals,
//   sealedCiphertext: { ciphertext(hex), round, sealedCommitmentHash(hex) }, direction, weight }] }
//
// NO faking: every proof is a real Groth16 proof verifiable on-chain; every ciphertext is a real
// tlock-js encryption to a future drand round (undecryptable before the deadline).

import { buildSnapshot } from "@shadowkit/snapshot-tool";
import { generateVoteProof } from "@shadowkit/zk-prover";
import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";
import { proofToScJson, pubSignalsToScArray } from "./proof-marshal.mjs";
import { DEMO_HOLDERS } from "./_holders.js";

// Inlined copy of @shadowkit/shared `fieldToBe32Hex` (snarkjs decimal field string -> 32-byte BE
// hex). We DON'T import it from @shadowkit/shared because that barrel pulls in @stellar/stellar-sdk
// (sha.js/safe-buffer CJS) which does not survive esbuild ESM bundling here. Same pure BigInt math.
function fieldToBe32Hex(decimal: string): string {
  if (!/^\d+$/.test(decimal)) throw new Error(`fieldToBe32Hex: not a decimal field string: ${decimal}`);
  const hex = BigInt(decimal).toString(16);
  if (hex.length > 64) throw new Error(`fieldToBe32Hex: value exceeds 32 bytes`);
  return "0x" + hex.padStart(64, "0");
}

const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};

const proposalId = arg("--proposal-id", "0")!;
const deadline = Number(arg("--deadline", "0"));
const wasmPath = arg("--wasm", "packages/zk-prover/artifacts/vote.wasm")!;
const zkeyPath = arg("--zkey", "packages/zk-prover/artifacts/vote_final.zkey")!;
if (!deadline) { console.error("gen-sealed-votes: --deadline <unix> required"); process.exit(1); }

// The 3 demo holders (single source of truth: _holders.ts). 2 YES (200 + 150 = 350) vs 1 NO (300):
// yes>no AND 3 voters >= min_voters(3) -> APPROVED, so the agent executes the swap (the showcase).
// Each holder has a UNIQUE secret -> unique nullifier (no double-vote collision).
const holders = DEMO_HOLDERS;

async function main() {
  // secretCommit = Poseidon(secret) (circuit constraint #1), leaf = Poseidon(secretCommit, weight).
  const leaves = [];
  for (const h of holders) {
    leaves.push({ secretCommit: await poseidonHashBls([h.secret]), weight: h.weight });
  }
  const snap = await buildSnapshot(leaves);

  const votes = [];
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const { merklePath, pathIndices } = snap.getPath(i);
    const r = await generateVoteProof(
      {
        secret: h.secret,
        merklePath,
        pathIndices,
        weight: h.weight,
        proposalId,
        direction: h.direction,
        merkleRoot: snap.root,
      },
      { wasmPath, zkeyPath },
      deadline, // REAL tlock: seal to the drand round at this unix deadline
    );
    const proof = await proofToScJson(r.proof);
    const pubSignals = pubSignalsToScArray(r.publicSignals); // decimal-string Array<u256>, BINDING order
    // sealed_ciphertext for the CLI: ciphertext as hex (CLI wants hex_bytes), round u64, commit 32-hex.
    // generateVoteProof stamps sealedCommitmentHash from the proof's 4th public signal, which snarkjs
    // returns as a DECIMAL field string — convert it to 32-byte big-endian hex (BytesN<32>) so it
    // equals pub_signals[3] as bytes (the on-chain RevealMismatch guard binds them).
    const ciphertextHex = Buffer.from(r.sealedCiphertext.ciphertext, "base64").toString("hex");
    const commitHex = fieldToBe32Hex(r.sealedCiphertext.sealedCommitmentHash).replace(/^0x/, "");
    votes.push({
      direction: h.direction,
      weight: h.weight,
      proof,
      pubSignals,
      sealedCiphertext: {
        ciphertext: ciphertextHex,
        ciphertextB64: r.sealedCiphertext.ciphertext, // kept for reveal (tlock decrypt)
        round: r.sealedCiphertext.round,
        sealed_commitment_hash: commitHex,
      },
    });
  }

  process.stdout.write(JSON.stringify({
    root: snap.root,
    rootBe32Hex: snap.rootBe32Hex,
    deadline,
    votes,
  }));
}

main()
  // snarkjs/ffjavascript leave worker threads alive that block a natural exit; force-exit after the
  // manifest is fully flushed to stdout so the demo shell isn't stalled waiting on the process.
  .then(() => new Promise<void>((r) => process.stdout.write("", () => r())))
  .then(() => process.exit(0))
  .catch((e) => { console.error("gen-sealed-votes FAILED:", e?.stack || e); process.exit(1); });
