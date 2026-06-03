// web/src/lib/voteClient.ts — the BROWSER ShadowFund voting client (foundation §3.x ported to the
// browser). Everything here is REAL: a snarkjs Groth16 proof over the LIVE circuit artifacts served
// at /zk/*, a REAL tlock-js seal/unseal to/from a drand quicknet round, the on-chain proof/signal
// marshalling the deployed GovVault.cast_vote consumes, and a Soroban transaction built + submitted
// against the LIVE testnet (CONFIG.rpcUrl). NO mocks on this path.
//
// PUBLIC-SIGNAL BINDING ORDER (foundation §4 / contracts/gov-vault/src/lib.rs):
//   ON-CHAIN  : [merkleRoot, nullifier, proposalId, sealedCommitmentHash]   (what cast_vote reads)
//   snarkjs   : [nullifier, merkleRoot, proposalId, sealedCommitmentHash]   (fullProve native output)
// buildVoteProof returns the named PublicSignals; toOnChainPublicSignals re-maps to the on-chain order.
//
// Browser crypto notes:
//  - snarkjs.wtns.calculate / groth16.fullProve accept a Uint8Array wasm/zkey + a `{type:"mem"}`
//    output object (no fs) — verified working in jsdom/node.
//  - the in-circuit sealedCommitmentHash = Poseidon(direction, weight, sealKey) over BLS12-381. We
//    compute it by running the circuit's OWN poseidon3.wasm witness calculator (byte-parity with the
//    in-circuit Poseidon — circomlibjs/poseidon-lite are BN254 and would be WRONG).
//  - tlock-js is imported via its BUILT entry ("tlock-js/index.js"); its "source" field would
//    otherwise make Vite resolve a mismatched hoisted @noble/hashes whose strict abytes rejects
//    cross-realm Uint8Array (verified). Payload bytes are produced with TextEncoder (no Node Buffer).

// @ts-ignore — snarkjs is untyped (vendored types live in the workspace tsconfig paths; not needed here).
import * as snarkjs from "snarkjs";
import type { Groth16Proof, PublicSignals } from "@shadowkit/shared";
import { CONFIG } from "./config";

// The deterministic demo sealKey (matches packages/zk-prover/src/seal.ts — the committed fixtures use
// it). The ciphertext confidentiality comes from the tlock drand round, not this value; it only binds
// the in-circuit Poseidon commitment to the stored ciphertext (RevealMismatch guard).
const SEAL_KEY = "987654321";

/** A demo snapshot member (web/src/lib/snapshot.json). secret/weight/direction are demo-only. */
export interface SnapshotMember {
  secret: string;
  weight: string;
  direction: 0 | 1;
  merklePath: string[];
  pathIndices: number[];
}

/** The four public signals, in the ON-CHAIN binding order. */
export const PUBLIC_SIGNAL_ORDER = [
  "merkleRoot",
  "nullifier",
  "proposalId",
  "sealedCommitmentHash",
] as const;

/** Real tlock envelope for a sealed vote (foundation §3.1). */
export interface SealedCiphertext {
  round: number;
  /** base64(tlock armored) */
  ciphertext: string;
  /** 0x-prefixed 32-byte hex; == publicSignals.sealedCommitmentHash as bytes */
  sealedCommitmentHash: string;
}

export interface VoteProofResult {
  proof: Groth16Proof;
  publicSignals: PublicSignals; // named; on-chain order via toOnChainPublicSignals
  sealedCiphertext: SealedCiphertext;
}

/** The proving artifacts as in-memory bytes. In the browser these are fetched from /zk/*. */
export interface Artifacts {
  voteWasm: Uint8Array;
  voteZkey: Uint8Array;
  poseidon3Wasm: Uint8Array;
}

const isBrowser = typeof window !== "undefined" && typeof fetch !== "undefined";

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Load the proving artifacts. Browser: fetch from /zk/* (the circuit) and /zk/poseidon3.wasm.
 *  Node (tests): read from web/public/zk and the zk-prover artifacts dir. */
export async function loadArtifacts(): Promise<Artifacts> {
  if (isBrowser) {
    const [voteWasm, voteZkey, poseidon3Wasm] = await Promise.all([
      fetchBytes("/zk/vote.wasm"),
      fetchBytes("/zk/vote_final.zkey"),
      fetchBytes("/zk/poseidon3.wasm"),
    ]);
    return { voteWasm, voteZkey, poseidon3Wasm };
  }
  // Node test path. The specifiers are computed at runtime so the BROWSER bundler (Vite/esbuild)
  // does NOT try to resolve node builtins for this dead-in-browser branch (isBrowser is false only
  // under vitest/node). The `/* @vite-ignore */` + variable specifier keeps it out of the graph.
  const fsName = "node:" + "fs";
  const pathName = "node:" + "path";
  const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as typeof import("node:fs");
  const { resolve } = (await import(/* @vite-ignore */ pathName)) as typeof import("node:path");
  const cwd = process.cwd();
  const read = (p: string) => new Uint8Array(readFileSync(resolve(cwd, p)));
  return {
    voteWasm: read("public/zk/vote.wasm"),
    voteZkey: read("public/zk/vote_final.zkey"),
    poseidon3Wasm: read("../packages/zk-prover/artifacts/poseidon3.wasm"),
  };
}

/** snarkjs decimal field string -> 0x-prefixed 32-byte big-endian hex (BytesN<32> / Bls12381Fr).
 *  Pure BigInt math; same as @shadowkit/shared fieldToBe32Hex (inlined to avoid the barrel's
 *  stellar-sdk pull). Throws on a non-decimal string or a value over 32 bytes. */
export function fieldToBe32Hex(decimal: string): string {
  if (!/^\d+$/.test(decimal)) throw new Error(`fieldToBe32Hex: not a decimal field string: ${decimal}`);
  const hex = BigInt(decimal).toString(16);
  if (hex.length > 64) throw new Error(`fieldToBe32Hex: value exceeds 32 bytes`);
  return "0x" + hex.padStart(64, "0");
}

/** Compute the in-circuit commitment Poseidon(direction, weight, sealKey) over BLS12-381 by running
 *  the circuit's OWN poseidon3 witness calculator in memory. Returns the decimal field string. */
async function poseidon3(poseidon3Wasm: Uint8Array, inputs: [string, string, string]): Promise<string> {
  const wtns: { type: "mem"; data?: Uint8Array } = { type: "mem" };
  await snarkjs.wtns.calculate({ in: inputs }, poseidon3Wasm, wtns);
  const w: bigint[] = await snarkjs.wtns.exportJson(wtns);
  // helper circuit: index 0 is the constant 1, index 1 is the single output `out`.
  return w[1]!.toString();
}

/** REAL tlock-js (built entry) + drand quicknet client. Lazy so the heavy module only loads when
 *  sealing/unsealing. mainnetClient() == quicknet pinned with beacon verification ON. */
async function tlock() {
  // @ts-ignore — force the BUILT entry (see header: avoids the `source` field's noble mismatch).
  const mod: any = await import("tlock-js/index.js");
  return mod as {
    timelockEncrypt: (round: number, payload: Uint8Array, client: unknown) => Promise<string>;
    timelockDecrypt: (armored: string, client: unknown) => Promise<Uint8Array>;
    mainnetClient: () => unknown;
  };
}

/** Map a unix-seconds deadline to the drand round it should unlock at (REAL quicknet ChainInfo). */
async function roundForDeadline(deadlineUnixSeconds: number, client: unknown): Promise<number> {
  const { roundAt } = await import("drand-client");
  const info = await (client as { chain: () => { info: () => Promise<unknown> } }).chain().info();
  return roundAt(deadlineUnixSeconds * 1000, info as never);
}

/** Timelock-seal {direction, weight} to the drand round at `deadlineUnixSeconds` (REAL tlock). The
 *  `commitment` (Poseidon(direction,weight,sealKey)) is stamped from the proof's 4th signal by the
 *  caller; this returns the round + base64 armored ciphertext. */
async function sealVote(
  direction: 0 | 1,
  weight: string,
  deadlineUnixSeconds: number,
): Promise<{ round: number; ciphertextB64: string }> {
  const { timelockEncrypt, mainnetClient } = await tlock();
  const client = mainnetClient();
  const round = await roundForDeadline(deadlineUnixSeconds, client);
  const payload = new TextEncoder().encode(JSON.stringify({ direction, weight }));
  const armored = await timelockEncrypt(round, payload, client);
  // store base64(armored) per foundation §3.1 SealedVoteCiphertext.
  const b64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(armored)))
    : Buffer.from(armored, "utf-8").toString("base64");
  return { round, ciphertextB64: b64 };
}

/** Decrypt a sealed vote (REAL tlock). Throws tlock's "too early" error if the round is unreleased.
 *  Used by the RevealStage to recover {direction, weight} after close. */
export async function unsealVote(sealed: SealedCiphertext): Promise<{ direction: 0 | 1; weight: string }> {
  const { timelockDecrypt, mainnetClient } = await tlock();
  const armored = typeof atob === "function"
    ? decodeURIComponent(escape(atob(sealed.ciphertext)))
    : Buffer.from(sealed.ciphertext, "base64").toString("utf-8");
  const plain = await timelockDecrypt(armored, mainnetClient());
  const text = new TextDecoder().decode(plain instanceof Uint8Array ? plain : new Uint8Array(plain as ArrayBufferLike));
  const obj = JSON.parse(text) as { direction: 0 | 1; weight: string };
  return { direction: obj.direction, weight: obj.weight };
}

/** Build a REAL sealed vote: tlock-seal {direction,weight} to round(deadline), compute the in-circuit
 *  commitment, run snarkjs.groth16.fullProve over the LIVE artifacts, and return the named public
 *  signals + the sealed ciphertext (commitment stamped from the proof's 4th signal, so the on-chain
 *  SealedVote.sealed_commitment_hash == pub_signals[3] exactly). */
export async function buildVoteProof(
  member: SnapshotMember,
  proposalId: number,
  deadlineUnixSeconds: number,
  artifacts: Artifacts,
): Promise<VoteProofResult> {
  if (!member.merklePath?.length) throw new Error("buildVoteProof: empty merklePath");
  if (member.merklePath.length !== member.pathIndices.length) {
    throw new Error("buildVoteProof: path/index length mismatch");
  }
  // 1) REAL tlock seal of {direction, weight} to the drand round at the deadline.
  const sealed = await sealVote(member.direction, member.weight, deadlineUnixSeconds);
  // 2) the in-circuit commitment the circuit will constrain pub_signals[3] to equal.
  const commitDecimal = await poseidon3(artifacts.poseidon3Wasm, [
    String(member.direction),
    member.weight,
    SEAL_KEY,
  ]);
  // 3) REAL Groth16 proof over the LIVE circuit (in-memory wasm/zkey).
  const circuitInput = {
    merkleRoot: BigInt("0x" + CONFIG.merkleRoot).toString(), // decimal field for the circuit input
    proposalId: String(proposalId),
    sealedCommitmentHash: commitDecimal,
    secret: member.secret,
    weight: member.weight,
    direction: String(member.direction),
    pathElements: member.merklePath,
    pathIndices: member.pathIndices.map(String),
    sealKey: SEAL_KEY,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    artifacts.voteWasm,
    artifacts.voteZkey,
  );
  // snarkjs NATIVE order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash]. Re-map to named.
  const signals: PublicSignals = {
    nullifier: publicSignals[0]!,
    merkleRoot: publicSignals[1]!,
    proposalId: publicSignals[2]!,
    sealedCommitmentHash: publicSignals[3]!,
  };
  const sealedCiphertext: SealedCiphertext = {
    round: sealed.round,
    ciphertext: sealed.ciphertextB64,
    // BINDING: stamp the commitment from the proof's 4th public signal (decimal -> the same value).
    sealedCommitmentHash: signals.sealedCommitmentHash,
  };
  return { proof: proof as Groth16Proof, publicSignals: signals, sealedCiphertext };
}

/** Re-map the named public signals to the ON-CHAIN binding order decimal array
 *  [merkleRoot, nullifier, proposalId, sealedCommitmentHash] (cast_vote's pub_signals: Vec<Fr>). */
export function toOnChainPublicSignals(ps: PublicSignals): string[] {
  return [ps.merkleRoot, ps.nullifier, ps.proposalId, ps.sealedCommitmentHash];
}

/** The on-chain Proof bytes (groth16-verifier `Proof { a: G1(96), b: G2(192), c: G1(96) }`).
 *  Each as the standard BLS12-381 UNCOMPRESSED encoding ffjavascript emits (the soroban host layout,
 *  CAP-0059) — empirically on-chain-verified by the demo (proof-marshal.mjs provenance). */
export interface OnChainProof {
  a: string;
  b: string;
  c: string;
}

let _curvePromise: Promise<unknown> | null = null;
async function curve(): Promise<any> {
  // singleThread=true: avoids worker-thread spin-up (slow in headless/browser); same serialization.
  if (!_curvePromise) {
    // @ts-ignore — ffjavascript is untyped (it ships no @types); resolves at runtime (snarkjs dep).
    const { buildBls12381 } = await import("ffjavascript");
    _curvePromise = (buildBls12381 as (s: boolean) => Promise<unknown>)(true);
  }
  return _curvePromise;
}

const toHex = (buf: Uint8Array): string =>
  Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");

async function g1Hex(xDec: string, yDec: string): Promise<string> {
  const c = await curve();
  const p = c.G1.fromObject([BigInt(xDec), BigInt(yDec), 1n]);
  const buf = new Uint8Array(c.G1.F.n8 * 2); // 48*2 = 96
  c.G1.toRprUncompressed(buf, 0, p);
  return toHex(buf);
}

async function g2Hex(x: [string, string], y: [string, string]): Promise<string> {
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

/** Marshal a snarkjs Groth16 proof into the on-chain `Proof { a, b, c }` hex bytes. */
export async function marshalProof(proof: Groth16Proof): Promise<OnChainProof> {
  const a = await g1Hex(proof.pi_a[0], proof.pi_a[1]);
  // snarkjs pi_b = [[x.c0, x.c1], [y.c0, y.c1], [1,0]] (the 3rd is the projective z, dropped).
  const b = await g2Hex(proof.pi_b[0], proof.pi_b[1]);
  const c = await g1Hex(proof.pi_c[0], proof.pi_c[1]);
  return { a, b, c };
}

// ============================================================================================
// Soroban transaction layer — build + submit cast_vote / close_and_reveal against LIVE testnet.
// The deployed GovVault ABI (contracts/gov-vault/src/lib.rs):
//   cast_vote(id: u32, proof: Proof, pub_signals: Vec<Bls12381Fr>, sealed_ciphertext: SealedVote)
//   close_and_reveal(id: u32, revealed_yes_w: i128, revealed_no_w: i128,
//                    decryptions: Vec<VoteDecryption>)
// The web/ gov-vault BINDING is the STALE M1 plaintext ABI (no sealed cast_vote / close_and_reveal),
// so we build the ScVal args directly from @stellar/stellar-sdk (nativeToScVal) and the Contract op.
// ============================================================================================

import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  Address,
  BASE_FEE,
  rpc,
} from "@stellar/stellar-sdk";

const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** A single revealed (tlock-decrypted) vote for close_and_reveal (foundation §2.6). */
export interface RevealDecryption {
  direction: 0 | 1;
  weight: string;
  /** 0x-prefixed (or bare) 32-byte hex; binds to the stored SealedVote.sealed_commitment_hash */
  sealedCommitmentHash: string;
}

/** ScVal for the on-chain `Proof { a: BytesN, b: BytesN, c: BytesN }` (fields sorted by symbol). */
function proofScVal(p: OnChainProof): xdr.ScVal {
  return nativeToScVal(
    { a: hexToBytes(p.a), b: hexToBytes(p.b), c: hexToBytes(p.c) },
    { type: { a: ["symbol", null], b: ["symbol", null], c: ["symbol", null] } },
  );
}

/** ScVal for `pub_signals: Vec<Bls12381Fr>` — each Fr is the 32-byte big-endian (be32) bytes. */
function pubSignalsScVal(decimalSignals: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    decimalSignals.map((d) => xdr.ScVal.scvBytes(Buffer.from(hexToBytes(fieldToBe32Hex(d))))),
  );
}

/** ScVal for `sealed_ciphertext: SealedVote { ciphertext: Bytes, round: u64, sealed_commitment_hash:
 *  BytesN<32> }`. ciphertext bytes are the raw tlock-armored bytes (hex of the base64-decoded blob),
 *  matching the demo CLI's `ciphertext` hex (gen-sealed-votes.ts). */
function sealedVoteScVal(sealed: SealedCiphertext): xdr.ScVal {
  // base64 -> armored utf8 -> raw bytes (same body the CLI passes as hex_bytes).
  const armored = typeof atob === "function"
    ? decodeURIComponent(escape(atob(sealed.ciphertext)))
    : Buffer.from(sealed.ciphertext, "base64").toString("utf-8");
  const ctBytes = new TextEncoder().encode(armored);
  const commit32 = hexToBytes(fieldToBe32Hex(sealed.sealedCommitmentHash));
  return nativeToScVal(
    { ciphertext: ctBytes, round: sealed.round, sealed_commitment_hash: commit32 },
    {
      type: {
        ciphertext: ["symbol", null],
        round: ["symbol", "u64"],
        sealed_commitment_hash: ["symbol", null],
      },
    },
  );
}

/** ScVal for a `VoteDecryption { direction: u32, sealed_commitment_hash: BytesN<32>, weight: i128 }`. */
function voteDecryptionScVal(d: RevealDecryption): xdr.ScVal {
  return nativeToScVal(
    {
      direction: d.direction,
      sealed_commitment_hash: hexToBytes(fieldToBe32Hex(BigInt(d.sealedCommitmentHash.startsWith("0x") ? d.sealedCommitmentHash : "0x" + d.sealedCommitmentHash).toString())),
      weight: d.weight,
    },
    {
      type: {
        direction: ["symbol", "u32"],
        sealed_commitment_hash: ["symbol", null],
        weight: ["symbol", "i128"],
      },
    },
  );
}

export interface SubmitResult {
  txHash: string;
  status: string;
}

function rpcServer(): rpc.Server {
  // testnet soroban-rpc is https; allowHttp only matters for http endpoints.
  return new rpc.Server(CONFIG.rpcUrl, { allowHttp: CONFIG.rpcUrl.startsWith("http://") });
}

/** Build (simulate + prepare) the cast_vote transaction as an UNSIGNED XDR. The connected wallet
 *  is the source account AND signs. The proof's `pub_signals` carry the privacy — the voter's
 *  identity/weight/direction never leave the proof. Returns the prepared XDR to hand to the wallet. */
export async function buildCastVoteXdr(
  source: string,
  proposalId: number,
  result: VoteProofResult,
): Promise<string> {
  const onChainProof = await marshalProof(result.proof);
  const contract = new Contract(CONFIG.govVaultId);
  const op = contract.call(
    "cast_vote",
    nativeToScVal(proposalId, { type: "u32" }),
    proofScVal(onChainProof),
    pubSignalsScVal(toOnChainPublicSignals(result.publicSignals)),
    sealedVoteScVal(result.sealedCiphertext),
  );
  const server = rpcServer();
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/** Build the close_and_reveal transaction XDR (admin/demo close path). */
export async function buildCloseAndRevealXdr(
  source: string,
  proposalId: number,
  revealedYesW: string,
  revealedNoW: string,
  decryptions: RevealDecryption[],
): Promise<string> {
  const contract = new Contract(CONFIG.govVaultId);
  const op = contract.call(
    "close_and_reveal",
    nativeToScVal(proposalId, { type: "u32" }),
    nativeToScVal(revealedYesW, { type: "i128" }),
    nativeToScVal(revealedNoW, { type: "i128" }),
    xdr.ScVal.scvVec(decryptions.map(voteDecryptionScVal)),
  );
  const server = rpcServer();
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  return prepared.toXDR();
}

/** Submit a wallet-signed XDR to the LIVE testnet and poll to completion. */
export async function submitSignedXdr(signedXdr: string): Promise<SubmitResult> {
  const server = rpcServer();
  const tx = TransactionBuilder.fromXDR(signedXdr, CONFIG.networkPassphrase);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`sendTransaction ERROR: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  const hash = sent.hash;
  // poll until not PENDING/NOT_FOUND.
  for (let i = 0; i < 30; i++) {
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return { txHash: hash, status: "SUCCESS" };
    if (res.status === "FAILED") {
      throw new Error(`tx FAILED: ${hash} ${JSON.stringify(res.resultXdr ?? "")}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { txHash: hash, status: "TIMEOUT" };
}

/** REAL tlock reveal of a set of sealed ciphertexts (in the SAME order they were cast on-chain),
 *  re-aggregating the weighted yes/no and building the close_and_reveal decryptions[] (one per sealed
 *  vote, each carrying its sealed_commitment_hash so the chain binds it to the stored ciphertext).
 *  A not-yet-released round throws tlock's real "too early" error (no partial reveal). */
export async function buildRevealFromSealed(
  sealedVotes: SealedCiphertext[],
): Promise<{ revealedYesW: string; revealedNoW: string; decryptions: RevealDecryption[] }> {
  let yes = 0n;
  let no = 0n;
  const decryptions: RevealDecryption[] = [];
  for (const sv of sealedVotes) {
    const { direction, weight } = await unsealVote(sv); // REAL tlock decrypt
    const w = BigInt(weight);
    if (direction === 1) yes += w;
    else no += w;
    decryptions.push({ direction, weight, sealedCommitmentHash: sv.sealedCommitmentHash });
  }
  return { revealedYesW: yes.toString(), revealedNoW: no.toString(), decryptions };
}

/** Read a proposal's votes_cast count (the safe public counter — never the tally). */
export async function readVotesCast(proposalId: number): Promise<number> {
  const server = rpcServer();
  const contract = new Contract(CONFIG.govVaultId);
  const op = contract.call("votes_cast", nativeToScVal(proposalId, { type: "u32" }));
  // a throwaway source for simulation-only read (must be a funded account); use the deployer addr.
  const account = await server.getAccount(CONFIG.deployerAddr);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`votes_cast sim: ${sim.error}`);
  const retval = sim.result?.retval;
  if (!retval) return 0;
  const { scValToNative } = await import("@stellar/stellar-sdk");
  return Number(scValToNative(retval));
}

/** Read is_approved (true iff the proposal closed Approved). View; simulation-only. */
export async function readIsApproved(proposalId: number): Promise<boolean> {
  const server = rpcServer();
  const contract = new Contract(CONFIG.govVaultId);
  const op = contract.call("is_approved", nativeToScVal(proposalId, { type: "u32" }));
  const account = await server.getAccount(CONFIG.deployerAddr);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: CONFIG.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`is_approved sim: ${sim.error}`);
  const retval = sim.result?.retval;
  if (!retval) return false;
  const { scValToNative } = await import("@stellar/stellar-sdk");
  return Boolean(scValToNative(retval));
}

void Address; // (kept import surface stable; Address used by future auth flows)
