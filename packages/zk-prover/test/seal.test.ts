// packages/zk-prover/test/seal.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_DRAND, clientFor } from "../src/drandConfig.js";

describe("drandConfig", () => {
  it("defaults to drand quicknet (verified against installed tlock-js mainnetClient 2026-06-02)", () => {
    // SOURCE: tlock-js@0.9.0 index.js mainnetClient() — chainHash + publicKey + URL are
    // exactly quicknet (MAINNET_CHAIN_URL = api.drand.sh/<hash>, period 3, genesis 1692803367,
    // schemeID bls-unchained-g1-rfc9380). drand-client build/index.d.ts ChainVerificationParams
    // REQUIRES BOTH { chainHash, publicKey } — chainHash alone does NOT pin the chain.
    expect(DEFAULT_DRAND.chainHash).toBe(
      "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    );
    expect(DEFAULT_DRAND.publicKey).toBe(
      "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
    );
    expect(DEFAULT_DRAND.chainUrl).toContain("api.drand.sh");
  });

  it("builds a drand-client ChainClient (tlock-js accepts) with verification ENABLED", () => {
    const client = clientFor();
    // drand-client ChainClient exposes chain() + an options bag (SOURCE: drand-client
    // build/index.d.ts: interface ChainClient { options, latest(), get(), chain() }).
    expect(typeof (client as { chain?: unknown }).chain).toBe("function");
    const opts = (client as { options: { disableBeaconVerification: boolean;
      chainVerificationParams?: { chainHash: string; publicKey: string } } }).options;
    // Verification MUST be ON and pinned to quicknet's { chainHash, publicKey }
    // (this is what fails if you only pass { chainHash } — see drand-client ChainOptions).
    expect(opts.disableBeaconVerification).toBe(false);
    expect(opts.chainVerificationParams?.chainHash).toBe(DEFAULT_DRAND.chainHash);
    expect(opts.chainVerificationParams?.publicKey).toBe(DEFAULT_DRAND.publicKey);
  });
});

import { roundForDeadline } from "../src/seal.js";

describe("roundForDeadline (REAL quicknet round↔deadline)", () => {
  // quicknet: genesis_time 1692803367 (s), period 3 (s). round 1 == genesis.
  // round(t) = floor((t - genesis)/period) + 1 ; we assert via the drand-client
  // round-trip (roundAt then roundTime) against the REAL chain info.
  it("round-trips a known deadline against real quicknet chain info", async () => {
    const genesis = 1692803367;
    const period = 3;
    // pick a deadline 100 rounds after genesis
    const deadline = genesis + 100 * period; // exactly the start of round 101
    const round = await roundForDeadline(deadline);
    expect(round).toBe(101);
  }, 30_000);

  it("is monotonic: a later deadline maps to a >= round", async () => {
    const a = await roundForDeadline(1692803367 + 10 * 3);
    const b = await roundForDeadline(1692803367 + 20 * 3);
    expect(b).toBeGreaterThan(a);
  }, 30_000);
});

import { timelockSealVote, timelockUnsealVote } from "../src/seal.js";

describe("timelockSealVote / timelockUnsealVote (REAL tlock-js)", () => {
  it("round-trips (direction,weight) through real tlock against a PAST round", async () => {
    // PAST deadline -> already-released round -> decryptable now (real beacon).
    const pastDeadline = 1692803367 + 5 * 3; // round ~6, long released
    const sealed = await timelockSealVote(1, "4200", pastDeadline);
    expect(sealed.round).toBeGreaterThan(0);
    expect(typeof sealed.ciphertext).toBe("string");
    expect(sealed.ciphertext.length).toBeGreaterThan(0);

    const opened = await timelockUnsealVote(sealed);
    expect(opened.direction).toBe(1);
    expect(opened.weight).toBe("4200");
  }, 60_000);

  it("is UNDECRYPTABLE before its round (real tlock early-decrypt gate)", async () => {
    // FUTURE deadline -> round not yet reached -> real decrypter throws.
    const future = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // +1yr
    const sealed = await timelockSealVote(0, "7", future);
    // SOURCE: tlock-js timelock-decrypter.ts throws
    //   "It's too early to decrypt the ciphertext - decryptable at round N".
    await expect(timelockUnsealVote(sealed)).rejects.toThrow(/too early/i);
  }, 60_000);
});

import { generateVoteProof } from "../src/index.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

describe("generateVoteProof binds sealedCiphertext.sealedCommitmentHash to publicSignals[3]", () => {
  it("seals and stamps the commitment hash from the proof", async () => {
    // Reuse the committed M4 sample input (valid witness) from the prover artifacts dir.
    const ART = resolve(__dirname, "../artifacts");
    const wasmPath = resolve(ART, "vote.wasm");
    const zkeyPath = resolve(ART, "vote_final.zkey");
    // Rebuild the same single-voter input the committed fixture uses (depth 20, voter at index 0).
    const { poseidonHashBls } = await import("../src/poseidon.js");
    const DEPTH = 20, secret = "12345", weight = "1000", proposalId = "0", direction = 1 as const;
    const secretCommit = await poseidonHashBls([secret]);
    const leaf = await poseidonHashBls([secretCommit, weight]);
    const zero = ["0"]; for (let i = 1; i <= DEPTH; i++) zero.push(await poseidonHashBls([zero[i - 1]!, zero[i - 1]!]));
    const merklePath: string[] = [], pathIndices: number[] = [];
    let cur = leaf; for (let i = 0; i < DEPTH; i++) { merklePath.push(zero[i]!); pathIndices.push(0); cur = await poseidonHashBls([cur, zero[i]!]); }
    void readFileSync;

    const res = await generateVoteProof(
      { secret, merklePath, pathIndices, weight, proposalId, direction, merkleRoot: cur },
      { wasmPath, zkeyPath },
      1692803367 + 5 * 3, // past deadline -> decryptable for the assertion below
    );
    // BINDING: ciphertext commitment hash == proof's 4th public signal.
    expect(res.sealedCiphertext.sealedCommitmentHash).toBe(res.publicSignals.sealedCommitmentHash);
    expect(res.sealedCiphertext.round).toBeGreaterThan(0);
    // and it actually decrypts to the same direction/weight we sealed
    const opened = await timelockUnsealVote(res.sealedCiphertext);
    expect(opened.direction).toBe(direction);
    expect(opened.weight).toBe(weight);
  }, 90_000);
});
