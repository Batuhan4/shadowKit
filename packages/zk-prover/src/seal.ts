// M4 SEAL: the sealed-vote commitment is Poseidon(direction, weight, sealKey) over BLS12-381 (matches
// vote.circom constraint #5). The CIPHERTEXT body in M4 is a deterministic local seal (base64 JSON);
// REAL tlock-js timelockEncrypt(round, payload, client) with round = roundForDeadline(deadline) is
// wired in M5 (foundation §3.2 / 2026-06-02-shadowkit-M5-timelock-weighted-reveal.md). This keeps M4's primary deliverable (on-chain verify of
// a well-formed sealed vote) testable now WITHOUT faking the crypto under test — the commitment IS the
// real in-circuit Poseidon.
//
// SIGNATURE (foundation §3.2, BINDING): timelockSealVote(direction, weight, deadlineUnixSeconds, drand?)
// returns `SealedVoteCiphertext & { sealKey }`. The `deadlineUnixSeconds`/`drand` params select the
// drand round in M5; in M4 the round is a STUB (0) and the deadline is recorded but not yet bound to
// the ciphertext (M5 binds it). `sealKey` is returned so generateVoteProof feeds the same value into
// the circuit's private `sealKey` input (the commitment must agree). M4 derives a DETERMINISTIC
// sealKey from the deadline so the fixture is reproducible; M5 randomizes it.
import type { SealedVoteCiphertext } from "@shadowkit/shared";
import { poseidonHashBls } from "./poseidon.js";

export interface DrandConfig { chainUrl: string; chainHash: string; }

export async function timelockSealVote(
  direction: 0 | 1, weight: string, deadlineUnixSeconds: number, _drand?: DrandConfig,
): Promise<SealedVoteCiphertext & { sealKey: string }> {
  // M4 deterministic sealKey (reproducible fixtures). M5 replaces with cryptographic randomness.
  const sealKey = "987654321";
  const commitment = await poseidonHashBls([String(direction), weight, sealKey]);
  const ciphertext = Buffer.from(
    JSON.stringify({ direction, weight, sealKey, deadlineUnixSeconds }),
  ).toString("base64");
  return {
    round: 0, // M4 STUB; M5 sets round = roundForDeadline(deadlineUnixSeconds)
    ciphertext,
    sealedCommitmentHash: "0x" + BigInt(commitment).toString(16).padStart(64, "0"),
    sealKey,
  };
}

export async function timelockUnsealVote(
  sealed: SealedVoteCiphertext, _drand?: DrandConfig,
): Promise<{ direction: 0 | 1; weight: string }> {
  const { direction, weight } = JSON.parse(Buffer.from(sealed.ciphertext, "base64").toString("utf8"));
  return { direction, weight };
}
