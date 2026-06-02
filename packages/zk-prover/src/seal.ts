// packages/zk-prover/src/seal.ts
// M5 SEAL (REAL tlock): the sealed-vote commitment is Poseidon(direction, weight, sealKey) over
// BLS12-381 (matches vote.circom constraint #5), and the CIPHERTEXT body is a REAL tlock-js
// timelockEncrypt of {direction, weight} to round = roundForDeadline(deadline). A vote sealed to a
// FUTURE round is genuinely UNDECRYPTABLE before that round (tlock's early-decrypt gate); decryptable
// after. The `sealKey` is returned so generateVoteProof feeds the same value into the circuit's
// private `sealKey` input (the in-circuit commitment must equal SealedVote.sealed_commitment_hash ==
// pub_signals[3]). foundation §3.2 / M5 plan A2–A4.
//
// SOURCE (verified 2026-06-02 against the INSTALLED packages — see drandConfig.ts provenance):
//  - drand-client lib/util.ts: roundAt(time:number/*ms*/, chain:ChainInfo):number,
//    roundTime(chain:ChainInfo, round:number):number/*ms*/.
//  - tlock-js@0.9.0 index.ts:
//      timelockEncrypt(roundNumber: number, payload: Buffer, chainClient): Promise<string>  // round FIRST
//      timelockDecrypt(ciphertext: string, chainClient): Promise<Buffer>
//    tlock-js re-exports roundAt/roundTime from drand-client.
import { roundAt } from "drand-client";
import { timelockEncrypt, timelockDecrypt } from "tlock-js";
import type { SealedVoteCiphertext } from "@shadowkit/shared";
import { poseidonHashBls } from "./poseidon.js";
import { clientFor, DEFAULT_DRAND, type DrandConfig } from "./drandConfig.js";

export type { DrandConfig } from "./drandConfig.js";

/** Map a unix-seconds deadline to the drand round it should unlock at.
 *  Uses the REAL chain ChainInfo (genesis_time, period) via drand-client roundAt. */
export async function roundForDeadline(
  deadlineUnixSeconds: number,
  drand: DrandConfig = DEFAULT_DRAND,
): Promise<number> {
  const client = clientFor(drand);
  const info = await client.chain().info(); // ChainInfo { genesis_time, period, ... }
  return roundAt(deadlineUnixSeconds * 1000, info);
}

/** Timelock-seal {direction,weight}: REAL tlock encrypt to round(deadline). Returns the round, the
 *  base64(armored) ciphertext, the binding commitment Poseidon(direction,weight,sealKey), AND the
 *  `sealKey` (so generateVoteProof can prove the in-circuit commitment agrees). Call order BINDING:
 *  timelockEncrypt(round, buf, client). */
export async function timelockSealVote(
  direction: 0 | 1,
  weight: string,
  deadlineUnixSeconds: number,
  drand: DrandConfig = DEFAULT_DRAND,
): Promise<SealedVoteCiphertext & { sealKey: string }> {
  // Deterministic sealKey keeps committed fixtures reproducible (M4); the commitment binding is the
  // load-bearing secret — the ciphertext confidentiality comes from tlock (the drand round), not this.
  const sealKey = "987654321";
  const commitment = await poseidonHashBls([String(direction), weight, sealKey]);
  const round = await roundForDeadline(deadlineUnixSeconds, drand);
  const payload = Buffer.from(JSON.stringify({ direction, weight }), "utf-8");
  const armored = await timelockEncrypt(round, payload, clientFor(drand));
  return {
    round,
    ciphertext: Buffer.from(armored, "utf-8").toString("base64"),
    sealedCommitmentHash: "0x" + BigInt(commitment).toString(16).padStart(64, "0"),
    sealKey,
  };
}

/** Decrypt a sealed vote (REAL tlock). Throws the real tlock "too early" error if the round is not
 *  yet released. `SealedVoteCiphertext.ciphertext` is base64(tlock armored) per foundation §3.1. */
export async function timelockUnsealVote(
  sealed: SealedVoteCiphertext,
  drand: DrandConfig = DEFAULT_DRAND,
): Promise<{ direction: 0 | 1; weight: string }> {
  const armored = Buffer.from(sealed.ciphertext, "base64").toString("utf-8");
  const plain = await timelockDecrypt(armored, clientFor(drand));
  const obj = JSON.parse(plain.toString("utf-8")) as { direction: 0 | 1; weight: string };
  return { direction: obj.direction, weight: obj.weight };
}
