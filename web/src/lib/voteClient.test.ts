// @vitest-environment node
//
// voteClient.test.ts — REAL round-trip tests for the browser ShadowFund voting client.
//
// NO CHEATING (charter): every proof here is a REAL snarkjs Groth16 proof over the LIVE circuit
// artifacts (web/public/zk/*), for a REAL snapshot member whose Merkle root equals CONFIG.merkleRoot,
// and every seal is a REAL tlock-js encryption to a real drand quicknet round. We assert:
//   - the on-chain public-signal BINDING order [merkleRoot, nullifier, proposalId, sealedCommitmentHash],
//   - that the produced proof VERIFIES against the shipped verification_key.json,
//   - that the marshalled on-chain Proof bytes are the right lengths (G1=96, G2=192),
//   - that the proof binds to the snapshot root (== CONFIG.merkleRoot) and the proposal id,
//   - a real tlock seal+unseal round-trip recovers {direction, weight},
//   - negative: a tampered proof FAILS verification (no always-true assert).
//
// Runs in the `node` environment (snarkjs/ffjavascript/tlock heavy crypto + real network to drand).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadArtifacts,
  buildVoteProof,
  toOnChainPublicSignals,
  marshalProof,
  fieldToBe32Hex,
  unsealVote,
  buildRevealFromSealed,
  PUBLIC_SIGNAL_ORDER,
  type SnapshotMember,
} from "./voteClient.js";
import snapshot from "./snapshot.json" with { type: "json" };
import { CONFIG } from "./config.js";
// @ts-ignore — snarkjs is untyped
import * as snarkjs from "snarkjs";

const CWD = process.cwd();
const vkey = JSON.parse(readFileSync(resolve(CWD, "public/zk/verification_key.json"), "utf8"));
const member0: SnapshotMember = snapshot.members[0] as SnapshotMember; // secret 111111, weight 200, YES
const PROPOSAL_ID = 0;
// a near-future deadline so the tlock round is in the future when sealing (real drand quicknet).
const deadline = Math.floor(Date.now() / 1000) + 120;

describe("voteClient — binding order constant", () => {
  it("declares the ON-CHAIN public-signal order [merkleRoot, nullifier, proposalId, sealedCommitmentHash]", () => {
    expect(PUBLIC_SIGNAL_ORDER).toEqual([
      "merkleRoot",
      "nullifier",
      "proposalId",
      "sealedCommitmentHash",
    ]);
  });
});

describe("voteClient — fieldToBe32Hex", () => {
  it("converts a decimal field string to 0x-prefixed 32-byte big-endian hex", () => {
    expect(fieldToBe32Hex("0")).toBe("0x" + "00".repeat(32));
    expect(fieldToBe32Hex("1")).toBe("0x" + "00".repeat(31) + "01");
    // the snapshot root decimal -> CONFIG.merkleRoot (the chain stores this exact BytesN<32>)
    expect(fieldToBe32Hex(snapshot.merkleRoot).replace(/^0x/, "")).toBe(CONFIG.merkleRoot);
  });
  it("rejects a non-decimal string", () => {
    expect(() => fieldToBe32Hex("0xdead")).toThrow();
  });
});

describe("voteClient — REAL proof generation", () => {
  it("produces a REAL Groth16 proof that VERIFIES, in BINDING public-signal order", async () => {
    const artifacts = await loadArtifacts();
    const r = await buildVoteProof(member0, PROPOSAL_ID, deadline, artifacts);

    // BINDING order public signals (the shape cast_vote expects on-chain).
    expect(Object.keys(r.publicSignals).sort()).toEqual(
      [...PUBLIC_SIGNAL_ORDER].sort()
    );
    // proposalId signal == this proposal (binds the proof to it; cross-proposal replay fails).
    expect(r.publicSignals.proposalId).toBe(String(PROPOSAL_ID));
    // merkleRoot signal -> CONFIG.merkleRoot (anti-stale; the chain checks this).
    expect(fieldToBe32Hex(r.publicSignals.merkleRoot).replace(/^0x/, "")).toBe(CONFIG.merkleRoot);
    // the sealed commitment is the proof's 4th signal AND the stored ciphertext's commitment.
    expect(r.sealedCiphertext.sealedCommitmentHash).toBe(r.publicSignals.sealedCommitmentHash);

    // VERIFY against the shipped vkey (snarkjs NATIVE order [nullifier, merkleRoot, proposalId, commit]).
    const native = [
      r.publicSignals.nullifier,
      r.publicSignals.merkleRoot,
      r.publicSignals.proposalId,
      r.publicSignals.sealedCommitmentHash,
    ];
    expect(await snarkjs.groth16.verify(vkey, native, r.proof)).toBe(true);
  }, 120000);

  it("NEGATIVE: a tampered proof FAILS verification", async () => {
    const artifacts = await loadArtifacts();
    const r = await buildVoteProof(member0, PROPOSAL_ID, deadline, artifacts);
    // flip the nullifier signal -> the pairing check must fail.
    const tampered = [
      (BigInt(r.publicSignals.nullifier) + 1n).toString(),
      r.publicSignals.merkleRoot,
      r.publicSignals.proposalId,
      r.publicSignals.sealedCommitmentHash,
    ];
    expect(await snarkjs.groth16.verify(vkey, tampered, r.proof)).toBe(false);
  }, 120000);

  it("distinct members produce DISTINCT nullifiers (no double-vote collision)", async () => {
    const artifacts = await loadArtifacts();
    const a = await buildVoteProof(snapshot.members[0] as SnapshotMember, PROPOSAL_ID, deadline, artifacts);
    const b = await buildVoteProof(snapshot.members[1] as SnapshotMember, PROPOSAL_ID, deadline, artifacts);
    expect(a.publicSignals.nullifier).not.toBe(b.publicSignals.nullifier);
  }, 180000);
});

describe("voteClient — on-chain encoding helpers", () => {
  it("toOnChainPublicSignals returns the decimal array in BINDING order", async () => {
    const artifacts = await loadArtifacts();
    const r = await buildVoteProof(member0, PROPOSAL_ID, deadline, artifacts);
    const arr = toOnChainPublicSignals(r.publicSignals);
    expect(arr).toEqual([
      r.publicSignals.merkleRoot,
      r.publicSignals.nullifier,
      r.publicSignals.proposalId,
      r.publicSignals.sealedCommitmentHash,
    ]);
  }, 120000);

  it("marshalProof emits G1(96)/G2(192)/G1(96) uncompressed hex", async () => {
    const artifacts = await loadArtifacts();
    const r = await buildVoteProof(member0, PROPOSAL_ID, deadline, artifacts);
    const sc = await marshalProof(r.proof);
    expect(/^[0-9a-f]+$/.test(sc.a)).toBe(true);
    expect(sc.a.length).toBe(96 * 2); // G1 uncompressed
    expect(sc.b.length).toBe(192 * 2); // G2 uncompressed
    expect(sc.c.length).toBe(96 * 2); // G1 uncompressed
  }, 120000);
});

describe("voteClient — REAL tlock seal/unseal round-trip", () => {
  it("recovers {direction, weight} from a sealed ciphertext for a RELEASED round", async () => {
    const artifacts = await loadArtifacts();
    // seal to a PAST deadline so the round is already released -> decryptable now (real drand).
    const past = Math.floor(Date.now() / 1000) - 120;
    const r = await buildVoteProof(member0, PROPOSAL_ID, past, artifacts);
    const out = await unsealVote(r.sealedCiphertext);
    expect(out).toEqual({ direction: member0.direction, weight: member0.weight });
  }, 120000);

  it("buildRevealFromSealed re-aggregates the 3-member tally (2 YES 350 vs 1 NO 300) -> Approved", async () => {
    const artifacts = await loadArtifacts();
    const past = Math.floor(Date.now() / 1000) - 120; // released round, decryptable now
    const sealed = [] as Awaited<ReturnType<typeof buildVoteProof>>["sealedCiphertext"][];
    for (const m of snapshot.members as SnapshotMember[]) {
      const r = await buildVoteProof(m, PROPOSAL_ID, past, artifacts);
      sealed.push(r.sealedCiphertext);
    }
    const rev = await buildRevealFromSealed(sealed);
    // _holders.ts: 200 + 150 yes vs 300 no -> yes 350 > no 300 -> Approved with 3 voters.
    expect(rev.revealedYesW).toBe("350");
    expect(rev.revealedNoW).toBe("300");
    expect(rev.decryptions).toHaveLength(3);
    // each decryption binds to its sealed vote's commitment (in cast order).
    rev.decryptions.forEach((d, i) => {
      expect(d.sealedCommitmentHash).toBe(sealed[i]!.sealedCommitmentHash);
    });
    expect(BigInt(rev.revealedYesW) > BigInt(rev.revealedNoW)).toBe(true);
  }, 240000);
});
