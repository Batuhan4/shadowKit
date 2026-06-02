// scripts/demo/proof-marshal.mjs — convert a snarkjs Groth16 (BLS12-381) proof.json into the
// soroban Proof hex bytes the on-chain groth16-verifier accepts via `stellar contract invoke`.
//
// The verifier's Proof { a: G1Affine(96 bytes), b: G2Affine(192 bytes), c: G1Affine(96 bytes) }.
// The on-chain G1/G2 byte layout == the standard BLS12-381 UNCOMPRESSED encoding the Soroban host
// uses (CAP-0059), which is EXACTLY what ffjavascript's curve.G1/G2 `toRprUncompressed` emits
// (ffjavascript is the same lib snarkjs builds proofs with, so the field encoding is canonical).
//
// We deliberately do NOT hand-roll the Fp/Fp2 byte order — ffjavascript's toRprUncompressed is the
// source of truth for the uncompressed serialization. We then verify the produced bytes ON-CHAIN by
// actually casting a vote (cast-votes.ts), so this conversion is empirically validated, not assumed.

import { buildBls12381, utils as ffutils } from "ffjavascript";

let _curvePromise = null;
function curve() {
  // singleThread=true: the multi-threaded default spawns worker threads that are extremely slow to
  // initialize in a sandboxed/headless environment (minutes). Single-thread inits in <1s and the
  // serialization we use (toRprUncompressed) is identical either way.
  if (!_curvePromise) _curvePromise = buildBls12381(true);
  return _curvePromise;
}

const toHex = (buf) => Buffer.from(buf).toString("hex");

/** snarkjs affine coords (decimal strings) -> uncompressed G1 (96 bytes) hex.
 *  curve.G1.fromObject([x,y,z]) packs a (jacobian) point into ffjavascript's internal byte form;
 *  toRprUncompressed then emits the standard uncompressed encoding (the soroban host's layout). */
async function g1Hex(xDec, yDec) {
  const c = await curve();
  const p = c.G1.fromObject([BigInt(xDec), BigInt(yDec), 1n]);
  const buf = new Uint8Array(c.G1.F.n8 * 2); // 48*2 = 96
  c.G1.toRprUncompressed(buf, 0, p);
  return toHex(buf);
}

/** snarkjs G2 affine coords (each Fp2 = [c0, c1] decimal strings) -> uncompressed G2 (192 bytes) hex.
 *
 *  ffjavascript's curve.G2.toRprUncompressed emits the standard BLS12-381 uncompressed encoding
 *  (each Fp2 element as [c1, c0], big-endian) — which is BYTE-FOR-BYTE IDENTICAL to ark-bls12-381
 *  `serialize_uncompressed` (the encoding the deployed soroban groth16-verifier consumes) and is
 *  also what snarkjs builds proofs with. EMPIRICALLY VERIFIED (2026-06-03): the committed fixture
 *  proof marshalled this way is ACCEPTED by the on-chain verifier (verify -> true), and the bytes
 *  match `ark-bls12-381 0.4.0` serialize_uncompressed exactly. NO byte/limb reordering is needed
 *  for either G1 or G2. */
async function g2Hex(x, y) {
  const c = await curve();
  const p = c.G2.fromObject([
    [BigInt(x[0]), BigInt(x[1])],
    [BigInt(y[0]), BigInt(y[1])],
    [1n, 0n],
  ]);
  const buf = new Uint8Array(c.G2.F.n8 * 2); // 96*2 = 192
  c.G2.toRprUncompressed(buf, 0, p);
  return toHex(buf);
}

/** Convert a snarkjs Groth16Proof object into the soroban `Proof { a, b, c }` hex-bytes JSON. */
export async function proofToScJson(proof) {
  const a = await g1Hex(proof.pi_a[0], proof.pi_a[1]);
  // snarkjs pi_b = [[x.c0, x.c1], [y.c0, y.c1], [1,0]] (the third is the projective z, dropped).
  const b = await g2Hex(proof.pi_b[0], proof.pi_b[1]);
  const cc = await g1Hex(proof.pi_c[0], proof.pi_c[1]);
  return { a, b, c: cc };
}

/** publicSignals (BINDING order [merkleRoot, nullifier, proposalId, sealedCommitmentHash]) as the
 *  CLI's `Array<u256>` decimal-string array. The verifier reads them as Fr via U256(be32). */
export function pubSignalsToScArray(ps) {
  return [ps.merkleRoot, ps.nullifier, ps.proposalId, ps.sealedCommitmentHash];
}

export { ffutils };
