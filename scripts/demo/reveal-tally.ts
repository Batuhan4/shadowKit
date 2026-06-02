// scripts/demo/reveal-tally.ts — REAL tlock reveal at the deadline.
//
// Reads the sealed-vote manifest produced by gen-sealed-votes.ts (the SAME ciphertexts that were cast
// on-chain, in the SAME order), tlock-DECRYPTS each via @shadowkit/tally-reveal (REAL drand quicknet
// beacon — a vote sealed to a future round is genuinely undecryptable before it; decryptable after),
// re-aggregates the weighted yes/no, and emits the close_and_reveal CLI args (decryptions array +
// revealed_yes_w/revealed_no_w) as a single JSON line for the demo shell.
//
// REVEAL_MODE:
//   - "timelock" (DEFAULT, the showcase): REAL tlock decrypt via drand. The automated `just demo`
//     uses this — votes are sealed to a near-future drand round and decrypted once it releases.
//   - "coordinator": fallback for environments where the live drand beacon is unreachable. Skips the
//     tlock decrypt and trusts the manifest's plaintext {direction,weight} (which gen-sealed-votes
//     also recorded). The on-chain contract must be built with `--features coordinator-reveal` for
//     this path (it then trusts the admin-asserted aggregate). Documented, NOT the default.

import { buildRevealArgs } from "@shadowkit/tally-reveal";
import type { SealedVoteCiphertext } from "@shadowkit/shared";
import { readFileSync } from "node:fs";

const arg = (name: string, def?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};

const manifestPath = arg("--manifest", "/tmp/shadowkit-demo-votes.json")!;
const proposalId = Number(arg("--proposal-id", "0"));
const mode = (process.env.REVEAL_MODE ?? "timelock").toLowerCase();

interface VoteRec {
  direction: 0 | 1;
  weight: string;
  sealedCiphertext: { ciphertextB64: string; round: number; sealed_commitment_hash: string };
}

async function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { votes: VoteRec[] };
  // Rebuild the SealedVoteCiphertext[] in cast order (decryptions[i] binds to sealedVotes[i]).
  const sealed: SealedVoteCiphertext[] = manifest.votes.map((v) => ({
    round: v.sealedCiphertext.round,
    ciphertext: v.sealedCiphertext.ciphertextB64,
    sealedCommitmentHash: "0x" + v.sealedCiphertext.sealed_commitment_hash,
  }));

  let revealedYesW: string;
  let revealedNoW: string;
  let decryptions: Array<{ direction: number; sealed_commitment_hash: string; weight: string }>;

  if (mode === "coordinator") {
    // FALLBACK: trust the recorded plaintext (no tlock). The on-chain coordinator-reveal feature
    // ignores `decryptions` and accepts the admin-asserted aggregate.
    let yes = 0n, no = 0n;
    for (const v of manifest.votes) { if (v.direction === 1) yes += BigInt(v.weight); else no += BigInt(v.weight); }
    revealedYesW = yes.toString();
    revealedNoW = no.toString();
    decryptions = [];
  } else {
    // PRIMARY: REAL tlock decrypt via drand quicknet, then per-vote decryptions for on-chain re-agg.
    const args = await buildRevealArgs(proposalId, sealed);
    revealedYesW = args.revealedYesW;
    revealedNoW = args.revealedNoW;
    decryptions = args.decryptions.map((d) => ({
      direction: d.direction,
      sealed_commitment_hash: d.sealedCommitmentHash.replace(/^0x/, ""), // CLI wants raw hex bytes
      weight: d.weight,
    }));
  }

  // tlock-js / drand-client emit "beacon received: {...}" to stdout via console.log, which would
  // pollute our JSON. Emit the result on its OWN line prefixed with a unique marker so the demo shell
  // can grep exactly our payload (the shell does: grep '^DEMO_REVEAL_JSON=' | sed 's/^...=//').
  process.stdout.write("\nDEMO_REVEAL_JSON=" + JSON.stringify({ mode, revealedYesW, revealedNoW, decryptions }) + "\n");
}

main()
  .then(() => new Promise<void>((r) => process.stdout.write("", () => r())))
  .then(() => process.exit(0))
  .catch((e) => { console.error("reveal-tally FAILED:", (e as Error)?.stack || e); process.exit(1); });
