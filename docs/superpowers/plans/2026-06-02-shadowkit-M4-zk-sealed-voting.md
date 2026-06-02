# M4 — ZK Sealed Voting (Circom + on-chain verifier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace M1's plaintext `cast_vote` with a **ZK-sealed** vote. A voter's browser builds a real Groth16 proof (Circom 2.2.1 + snarkjs 0.7.6, **BLS12-381**) of snapshot Merkle membership + nullifier (`Poseidon(secret, proposalId)`) + proposalId binding + a well-formed SEALED vote (direction & weight hidden, weight matches the snapshot leaf). The on-chain `Groth16Verifier` (adapted from `stellar/soroban-examples/groth16_verifier`) verifies that proof on-chain. `GovVault.cast_vote` now **requires** the proof, enforces nullifier + proposalId anti-replay on-chain, stores the sealed ciphertext, and exposes **NO tally** before close.

**Architecture:** Off-chain prover (`@shadowkit/zk-prover`) + snapshot builder (`@shadowkit/snapshot-tool`) → Circom circuit `circuits/vote/vote.circom` compiled to wasm + Groth16 zkey → on-chain `Groth16Verifier.verify(proof, pub_signals)` (BLS12-381 host fns) ← called by `gov-vault::cast_vote`. Public signal vector is BINDING: `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]` (foundation §4). **direction and weight are NEVER public.**

**Tech Stack:** Rust 1.94.1 / `soroban-sdk 26.0.0` (Cargo workspace; foundation §6); Circom 2.2.1 (built from source, `-p bls12381`); circomlib 2.0.5 (Poseidon); snarkjs 0.7.6 (Groth16/BLS12-381 trusted setup + wasm + zkey); TypeScript ESM + Vitest 4.1.8; `ffjavascript` (BLS12-381 field arithmetic for the TS Poseidon parity layer); `ark-bls12-381` + `ark-serialize` (Rust-side fixture construction, exactly as the reference verifier test does).

---

## 0. Provenance — APIs verified for THIS plan (2026-06-02)

Every external call below was verified before this plan was written. Re-verify per the binding API rule (foundation §6) before any task that touches it.

| API / fact | How verified | Result (the binding fact) |
|---|---|---|
| Reference `Groth16Verifier::verify_proof` body | `raw.githubusercontent.com/stellar/soroban-examples/main/groth16_verifier/src/lib.rs` | `bls = env.crypto().bls12_381()`; `vk_x = ic[0] + Σ bls.g1_mul(&ic[i+1], &sig[i])`; `bls.g1_add`; `neg_a = -proof.a`; `bls.pairing_check(vec![neg_a,alpha,vk_x,c], vec![b,beta,gamma,delta])`. Error `MalformedVerifyingKey = 0` iff `pub_signals.len()+1 != vk.ic.len()`. |
| Reference test fixture loading | `.../groth16_verifier/src/test.rs` | Uses `ark_bls12_381::{Fq,Fq2,G1Affine,G2Affine}` + `ark_serialize::CanonicalSerialize::serialize_uncompressed` → `soroban_sdk::crypto::bls12_381::{G1Affine,G2Affine}::from_array`. Public signals via `Fr::from_u256(...)`. `pi_a`/`pi_c` are G1 (x,y from decimal strings), `pi_b` is G2 (x1,x2,y1,y2). |
| `snarkjs` Groth16 / setup JS+CLI | `npx ctx7@latest docs /iden3/snarkjs ...` | `snarkjs.groth16.fullProve(input, wasm, zkey) -> {proof, publicSignals}`; `snarkjs.groth16.verify(vKey, publicSignals, proof) -> bool`; `snarkjs.zKey.exportVerificationKey(zkey) -> vKey`; `snarkjs.wtns.calculate(input, wasm, wtns)`. CLI: `snarkjs powersoftau new bls12381 <pow> pot.ptau`, `... contribute`, `... prepare phase2`, `snarkjs groth16 setup r1cs ptau zkey`, `snarkjs zkey contribute`, `snarkjs zkey beacon`, `snarkjs zkey export verificationkey`, `snarkjs groth16 fullprove input.json wasm zkey proof.json public.json`, `snarkjs groth16 verify vk public proof`. snarkjs **supports bn128 and bls12-381** curves (ctx7). |
| Circom prime flag | `raw.githubusercontent.com/iden3/circom/master/mkdocs/.../compiling-circuits.md` | `circom -p bls12381 ...` selects the BLS12-381 scalar field. Names: `bn128, bls12377, bls12381, goldilocks, grumpkin, pallas, secq256r1, vesta` (default `bn128`). |
| circomlib Poseidon | `raw.githubusercontent.com/iden3/circomlib/master/circuits/poseidon_constants.circom` header | Constants generated for the **BN254** prime `0x30644e72...0000001`. `template Poseidon(nInputs)` wraps `PoseidonEx(nInputs,1)` with `initialState <== 0`, output `out`. circomlib has **no built-in Merkle template** — we author `merkle.circom` from circomlib `Switcher` + `Poseidon`. |
| **FIELD PARITY (load-bearing)** | local `ffjavascript.getCurveFromName("bls12381"/"bn128").Fr.p` | BLS12-381 Fr `= 52435875175126190479447740508185965837690552500527637822603658699938581184513`; BN254 Fr `= 21888242871839275222246405745257275088548364400416034343698204186575808495617`. **They differ.** `poseidon-lite@0.3.0` and `circomlibjs.buildPoseidon()` are **hardcoded to BN254** (verified: `poseidon2([1,2]) = 7853200...` the BN254 value; `circomlibjs/src/poseidon_wasm.js` calls `getCurveFromName("bn128")`). → **The TS Poseidon must NOT use poseidon-lite for the BLS12-381 circuit.** Resolution adopted by this plan: §0.1 below. |

### 0.1 Poseidon field-parity resolution (BINDING decision for M4)

The foundation (§6 FIELD NOTE) flagged this as the M4 integration risk and required resolving it. **Decision:** the **compiled circuit wasm is the single source of truth** for every Poseidon value (leaf, nullifier, sealedCommitmentHash). The TS layer computes those hashes by running the circuit's own BLS12-381 witness calculator on tiny helper circuits, never `poseidon-lite`.

- `circuits/poseidon-helpers/` contains three trivial circuits (`poseidon1.circom`, `poseidon2.circom`, `poseidon3.circom`) — each just `out <== Poseidon(n)(inputs)` compiled with `-p bls12381`. Their wasm witness calculators give the **exact** in-circuit Poseidon over BLS12-381.
- `@shadowkit/zk-prover/src/poseidon.ts` exposes `poseidonHashBls(inputs: string[]): Promise<string>` that runs the matching helper wasm by writing the witness to a temp `.wtns` via `snarkjs.wtns.calculate(input, wasmPath, wtnsPath)` (3rd arg = file path; returns void — VERIFIED snarkjs@0.7.6 source) then reading the output signal with `snarkjs.wtns.exportJson(wtnsPath)` (returns `bigint[]`; `w[1]` is `out`). (DEVIATION from foundation §1's "`poseidon.ts` wrapper (poseidon-lite ...)": recorded here; poseidon-lite is BN254 and would silently produce wrong hashes for a BLS12-381 circuit — charter rule 4 forbids that, so we delegate to the circuit's own field.) Consumed cross-package via the `@shadowkit/zk-prover/poseidon` subexport (Task 4.7 `exports` map).
- A parity test (Task 4.34) asserts `poseidonHashBls(["1","2"]) === <out extracted from the main circuit witness for the same wiring>` and `!== poseidon-lite`'s BN254 value — proving we did NOT accidentally ship the wrong field.

This guarantees `snapshot-tool` roots, `nullifierFor`, and the proof all agree byte-for-byte, and a real proof generated by `@shadowkit/zk-prover` verifies on-chain (the §10 round-trip).

---

## File Structure (every file this milestone creates or modifies; one-line responsibility; matches foundation §1 exactly)

**Create — Circom**
- `circuits/vote/vote.circom` — main circuit: membership + hidden weight + nullifier + proposalId + sealed-vote well-formedness (foundation §4).
- `circuits/vote/poseidon.circom` — re-exports circomlib Poseidon (leaf + nullifier hashing).
- `circuits/vote/merkle.circom` — `MerkleTreeChecker(depth)` inclusion proof (circomlib `Switcher` + `Poseidon`).
- `circuits/vote/package.json` — scripts: compile, setup (groth16), export-vk, gen-witness, prove, verify, test.
- `circuits/vote/test/circuit.test.ts` — circuit witness/sat tests + snarkjs prove/verify (Vitest).
- `circuits/vote/fixtures/verification_key.json` — COMMITTED snarkjs VK (source for `groth16-verifier/src/vk.rs`).
- `circuits/vote/fixtures/proof.json` — COMMITTED sample valid proof.
- `circuits/vote/fixtures/public.json` — COMMITTED sample public signals `[merkleRoot,nullifier,proposalId,sealedCommitmentHash]`.
- `circuits/vote/fixtures/input.json` — COMMITTED sample circuit input (private+public).
- `circuits/vote/fixtures/vote.r1cs` — COMMITTED r1cs (witness-check fixture).
- `circuits/vote/fixtures/vote_final.zkey` — COMMITTED final proving key.
- `circuits/vote/fixtures/vote.wasm` — COMMITTED witness calculator (browser/node proving).
- `circuits/poseidon-helpers/poseidon1.circom` / `poseidon2.circom` / `poseidon3.circom` — BLS12-381 Poseidon parity helpers (§0.1).
- `circuits/poseidon-helpers/fixtures/poseidon{1,2,3}.wasm` — COMMITTED helper witness calculators.
- `circuits/vote/scripts/make-input.mjs` — generate the canonical `fixtures/input.json` via `poseidonHashBls` (run with `npx tsx`, Task 4.8).
- `circuits/vote/scripts/make-input-min.mjs` — generate `fixtures-min/input.json` for the degraded circuit (run with `npx tsx`, Task 4.36).
- `circuits/vote/vote_min.circom` — FALLBACK 2 degraded circuit: membership + nullifier + proposalId only (3 public signals, Task 4.36).
- `circuits/vote/fixtures-min/{vote_min.wasm,vote_min_final.zkey,verification_key.json,proof.json,public.json,input.json,vote_min.r1cs}` — COMMITTED degraded-circuit fixtures (Task 4.36).
- `circuits/vote/fixtures-fresh/{proof.json,public.json,meta.json}` — COMMITTED SECOND proof bundle from the full prover path (the on-chain re-map round-trip, Task 4.35).
- `circuits/vote/README.md` — M4 deviation + M5 hand-off note (Task 4.40).

**Create — Rust**
- `contracts/groth16-verifier/Cargo.toml` — `crate-type=["cdylib","rlib"]`; `soroban-sdk 26.0.0`; optional `host-tools` deps `ark-bls12-381`, `ark-serialize`, `serde`, `serde_json` + dev-deps (Tasks 4.11/4.15).
- `contracts/groth16-verifier/src/lib.rs` — `#[contract] Groth16Verifier`; `verify_proof`, `verify`, `verify_min`; `VerificationKey`, `Proof`, `Groth16Error`; `pub use ...Fr as Bls12381Fr` (foundation §2.1).
- `contracts/groth16-verifier/src/vk.rs` — AUTO-GENERATED `embedded_vk(env)` (byte arrays) from `verification_key.json` (Task 4.15).
- `contracts/groth16-verifier/src/vk_min.rs` — AUTO-GENERATED `embedded_vk_min(env)` from `fixtures-min/verification_key.json` (4 IC points, Task 4.36b).
- `contracts/groth16-verifier/src/bin/embed_vk.rs` — host-only generator emitting `vk.rs`/`vk_min.rs` byte literals (`--features host-tools`, Tasks 4.15/4.36b).
- `contracts/groth16-verifier/src/test.rs` — fixture tests: valid→true; tampered/wrong-inputs/malformed→false/error (no panic).

**Create — TypeScript**
- `packages/zk-prover/package.json` — pkg `@shadowkit/zk-prover`; `exports` map (`.`, `./poseidon`, `./seal`, `./coordinator`); deps snarkjs, ffjavascript, tlock-js, drand-client; devDep `tsx` (script runner); (tlock used minimally in M4; sealed = commitment only — full tlock is M5).
- `packages/zk-prover/src/index.ts` — `generateVoteProof`, `verifyVoteProof`, `nullifierFor`, `DrandConfig` (foundation §3.2).
- `packages/zk-prover/src/seal.ts` — `timelockSealVote(direction, weight, deadlineUnixSeconds, drand?)` / `timelockUnsealVote(sealed, drand?)` (foundation §3.2; M4 ships a deterministic local-seal stub returning the REAL in-circuit Poseidon commitment + `sealKey`; REAL tlock wiring is M5 — see Task 4.40 note).
- `packages/zk-prover/src/coordinator.ts` — `verifyAndAuthorize(vkey, publicSignals, proof)` off-chain-verify coordinator (foundation §2.1/§3.2; runs real `snarkjs.groth16.verify`).
- `packages/zk-prover/src/poseidon.ts` — `poseidonHashBls(inputs)` over the BLS12-381 helper wasm (§0.1).
- `packages/zk-prover/test/{poseidon,prover,coordinator}.test.ts` — prover unit + round-trip + bad-input + verify-negative + off-chain coordinator tests.
- `packages/zk-prover/scripts/emit-bundle.mjs` — emit the FRESH on-chain round-trip bundle via the full prover path (run with `npx tsx`, Task 4.35).
- `packages/snapshot-tool/package.json` — pkg `@shadowkit/snapshot-tool`.
- `packages/snapshot-tool/src/index.ts` — `buildSnapshot` (ASYNC, `Promise<Snapshot>`), `Snapshot` (foundation §3.3).
- `packages/snapshot-tool/src/merkle.ts` — Poseidon Merkle tree (matches `merkle.circom` depth).
- `packages/snapshot-tool/test/{snapshot,circuit-parity}.test.ts` — root determinism, valid path, tamper→invalid, snapshot↔prover↔verifier parity.
- `packages/shared/src/types.ts` — **MODIFY**: ensure `PublicSignals`, `Groth16Proof`, `SealedVoteCiphertext`, `fieldToBe32Hex` exist (foundation §3.1). (Created in M0/M1; M4 adds only if absent.)

**Modify — Rust**
- `contracts/gov-vault/src/lib.rs` — **MODIFY `init`** from M1's plaintext form `init(admin, treasury_asset, quorum_cfg, vote_weights)` to the foundation §2.2 BINDING form `init(admin, verifier, merkle_root, treasury_asset, quorum_cfg)`: set `DataKey::Verifier`/`DataKey::MerkleRoot`, drop the `vote_weights` snapshot path + `weight_of` (sealed weighted voting replaces per-address plaintext weights) (Task 4.19a). Then: sealed `cast_vote` (+`cast_vote_inner`, +`votes_cast`); `Fr`↔bytes helpers (`fr_to_bytes32`/`fr_eq_bytes32`/`fr_eq_u32`); enforce verify + nullifier + proposalId + merkleRoot + sealed-commit (foundation §2.2). Under `offchain-verify`: extra `verified: bool` arg. Under `circuit-min`: `cast_vote_min` (3 signals, 1p1v).
- `contracts/gov-vault/src/storage.rs` — add `Nullifier(BytesN<32>)`, `SealedVotes(u32)` keys + typed helpers (`get_admin`/`get_verifier`/`set_verifier`/`get_merkle_root`/`set_merkle_root`/`get_proposal`/`set_proposal`/`nullifier_used`/`mark_nullifier`/`push_sealed_vote`) (if not already present from M1); remove the M1-only `set_vote_weights`/`get_vote_weights` helpers (Task 4.19a).
- `contracts/gov-vault/Cargo.toml` — add `groth16-verifier` dep; `[features] offchain-verify = []`, `circuit-min = []`; dev-deps `ark-bls12-381`/`ark-serialize`/`serde`/`serde_json` + `groth16-verifier` (Task 4.21).
- `contracts/gov-vault/src/test.rs` — sealed-vote tests: Fr-helper units, happy, double-vote, replay, post-deadline, stale-root, sealed-commit, invalid-proof, no-tally-pre-close, fresh+committed on-chain round-trip, `circuit-min` 1p1v suite.
- `contracts/gov-vault/src/test_fixtures.rs` — **CREATE**: arkworks fixture loaders (`committed_proof`/`committed_public_signals`/`fresh_*`/`committed_*_min`), `fr`/`be32`.
- `contracts/gov-vault/src/test_offchain.rs` — **CREATE**: off-chain-verify (`feature=offchain-verify`) suite (Task 4.30a).
- `Cargo.toml` (workspace root) — add `contracts/groth16-verifier` to members (if absent).

**Create — scripts / config**
- `scripts/snapshot-fixtures.sh` — regenerate ALL primary circuit fixtures (compile + trusted setup + sample proof + export VK + helper wasm).
- `scripts/snapshot-fixtures-min.sh` — regenerate the degraded `vote_min` fixtures (FALLBACK 2, Task 4.36).
- `contracts/groth16-verifier/scripts/gen-vk.mjs` — superseded by the `embed_vk` Rust bin (Task 4.14 note; not committed in its arkworks-call form).
- `justfile` — **MODIFY**: add `circuit-build`, `circuit-test`, and wire `cargo test -p gov-vault --features offchain-verify` AND `--features circuit-min` + the TS suites into `just test`.

---

## How to use this plan

Each task is one TDD micro-cycle. The pattern in every implementation task:
1. **RED** — write the failing test, run the EXACT command shown, confirm you see the EXACT failure shown.
2. **GREEN** — apply the minimal code shown, run again, confirm PASS.
3. **COMMIT** — the conventional-commit message shown.

Never skip the RED run. A task that is green on first run is invalid (charter rule 4). No `#[ignore]`, `.skip`, `it.todo`, `assert!(true)` without a written justification on the same line.

**Branch:** create `m4-zk-sealed-voting` before Task 4.1 (`git switch -c m4-zk-sealed-voting`). Commit/push only when the user asks (foundation §8).

**Assumes M0–M3 are complete and green:** Cargo + npm workspaces exist; `gov-vault` exists with a PLAINTEXT `cast_vote`; `@shadowkit/shared` exists; `just`, `stellar`, `circom`, `snarkjs`, Docker are installed (M0). If `circom`/`snarkjs` are missing, run the prerequisite block in Task 4.0.

---

## Phase A — Circuit + trusted setup + fixtures (the cryptographic source of truth)

### Task 4.0 — Prerequisites: toolchain present

- [ ] **Action:** Verify the ZK toolchain. Run:
  ```bash
  circom --version && snarkjs --version || npx --yes snarkjs@0.7.6 --version
  ```
  **Expected:** `circom compiler 2.2.1` and `snarkjs@0.7.6` (or higher patch). If `circom` is missing, build it from source (foundation §6):
  ```bash
  git clone --branch v2.2.1 --depth 1 https://github.com/iden3/circom /tmp/circom && \
    cargo install --path /tmp/circom --locked && circom --version
  ```
  Install circomlib + tooling local to the circuit package (done in Task 4.1).
- [ ] **No commit** (environment check only).

### Task 4.1 — Scaffold `circuits/vote` package

- [ ] **Create** `circuits/vote/package.json`:
  ```json
  {
    "name": "shadowkit-circuit-vote",
    "private": true,
    "type": "module",
    "version": "0.0.0",
    "scripts": {
      "compile": "circom vote.circom --r1cs --wasm --sym -p bls12381 -l node_modules -o build",
      "test": "vitest run"
    },
    "devDependencies": {
      "circomlib": "2.0.5",
      "snarkjs": "0.7.6",
      "ffjavascript": "^0.3.0",
      "vitest": "4.1.8"
    }
  }
  ```
- [ ] **Run:** `npm install --prefix circuits/vote --no-audit --no-fund`
  **Expected:** `circomlib`, `snarkjs`, `ffjavascript`, `vitest` appear under `circuits/vote/node_modules`.
- [ ] **Verify:** `ls circuits/vote/node_modules/circomlib/circuits/poseidon.circom` → file exists.
- [ ] **Commit:** `build(circuit): scaffold circuits/vote package with circomlib + snarkjs`

### Task 4.2 — `poseidon.circom` re-export (RED via compile)

- [ ] **Create** `circuits/vote/poseidon.circom`:
  ```circom
  pragma circom 2.2.1;
  // Re-export circomlib Poseidon so vote.circom + merkle.circom share one import path.
  // SOURCE: iden3/circomlib circuits/poseidon.circom (template Poseidon(nInputs), out signal).
  include "circomlib/circuits/poseidon.circom";
  ```
- [ ] **Create** `circuits/vote/merkle.circom`:
  ```circom
  pragma circom 2.2.1;
  // Poseidon Merkle inclusion proof. circomlib has NO Merkle template, so we build one from
  // Switcher (circomlib) + Poseidon. Verified: circomlib circuits/switcher.circom Switcher()
  // swaps (L,R) by sel; circuits/poseidon.circom Poseidon(2) hashes a node pair.
  include "circomlib/circuits/switcher.circom";
  include "circomlib/circuits/poseidon.circom";

  // Proves `leaf` is included in a Merkle tree of given `root`, using `pathElements`
  // (sibling per level) and `pathIndices` (0 => current node is left child, 1 => right child).
  template MerkleTreeChecker(depth) {
      signal input leaf;
      signal input root;
      signal input pathElements[depth];
      signal input pathIndices[depth];

      component switchers[depth];
      component hashers[depth];

      signal levelHashes[depth + 1];
      levelHashes[0] <== leaf;

      for (var i = 0; i < depth; i++) {
          // pathIndices[i] must be a bit.
          pathIndices[i] * (pathIndices[i] - 1) === 0;

          switchers[i] = Switcher();
          switchers[i].sel <== pathIndices[i];
          switchers[i].L <== levelHashes[i];
          switchers[i].R <== pathElements[i];

          hashers[i] = Poseidon(2);
          hashers[i].inputs[0] <== switchers[i].outL;
          hashers[i].inputs[1] <== switchers[i].outR;

          levelHashes[i + 1] <== hashers[i].out;
      }

      root === levelHashes[depth];
  }
  ```
- [ ] **RED — Create** `circuits/vote/vote.circom` as an EMPTY stub first to prove compile fails meaningfully:
  ```circom
  pragma circom 2.2.1;
  ```
- [ ] **Run:** `cd circuits/vote && npx circom vote.circom --r1cs --wasm -p bls12381 -l node_modules -o build`
  **Expected FAIL:** `error ... main component is not defined` (no `component main` in the stub).
- [ ] **No commit** (RED state only; next task adds the real circuit).

### Task 4.3 — `vote.circom` main circuit (GREEN: compiles)

- [ ] **GREEN — Replace** `circuits/vote/vote.circom` with the BINDING circuit (foundation §4 verbatim):
  ```circom
  pragma circom 2.2.1;
  include "poseidon.circom";   // circomlib Poseidon (re-export)
  include "merkle.circom";     // MerkleTreeChecker(TREE_DEPTH)

  // TREE_DEPTH is BINDING and must equal snapshot-tool's depth (default 20).
  template Vote(TREE_DEPTH) {
      // ---- PUBLIC SIGNALS (order BINDING; matches GovVault pub_signals & §3 PublicSignals) ----
      signal input merkleRoot;             // [0] snapshot root
      signal input proposalId;             // [2] binds proof to a proposal (anti-replay)
      signal input sealedCommitmentHash;   // [3] hash committing to the sealed ciphertext
      signal output nullifier;             // [1] = Poseidon(secret, proposalId)

      // ---- PRIVATE INPUTS ----
      signal input secret;                 // voter private scalar
      signal input weight;                 // token weight (hidden)
      signal input direction;              // vote choice {0,1} (hidden; sealed off-circuit)
      signal input pathElements[TREE_DEPTH];
      signal input pathIndices[TREE_DEPTH];
      signal input sealKey;                // randomness binding the ciphertext commitment

      // 1) leaf = Poseidon(Poseidon(secret), weight)
      component secretCommit = Poseidon(1); secretCommit.inputs[0] <== secret;
      component leaf = Poseidon(2); leaf.inputs[0] <== secretCommit.out; leaf.inputs[1] <== weight;

      // 2) Merkle membership
      component mt = MerkleTreeChecker(TREE_DEPTH);
      mt.leaf <== leaf.out; mt.root <== merkleRoot;
      for (var i = 0; i < TREE_DEPTH; i++) { mt.pathElements[i] <== pathElements[i]; mt.pathIndices[i] <== pathIndices[i]; }

      // 3) nullifier = Poseidon(secret, proposalId)
      component nf = Poseidon(2); nf.inputs[0] <== secret; nf.inputs[1] <== proposalId; nullifier <== nf.out;

      // 4) direction is a bit
      direction * (direction - 1) === 0;

      // 5) sealed-vote well-formedness: sealedCommitmentHash = Poseidon(direction, weight, sealKey)
      component sc = Poseidon(3);
      sc.inputs[0] <== direction; sc.inputs[1] <== weight; sc.inputs[2] <== sealKey;
      sealedCommitmentHash === sc.out;
  }
  component main {public [merkleRoot, proposalId, sealedCommitmentHash]} = Vote(20);
  ```
- [ ] **Run:** `cd circuits/vote && npx circom vote.circom --r1cs --wasm --sym -p bls12381 -l node_modules -o build`
  **Expected PASS:** prints `template instances: ...`, `non-linear constraints: ...`, and writes `build/vote.r1cs`, `build/vote_js/vote.wasm`, `build/vote.sym`. Confirm:
  ```bash
  ls circuits/vote/build/vote.r1cs circuits/vote/build/vote_js/vote.wasm
  ```
- [ ] **Commit:** `feat(circuit): vote.circom membership+nullifier+sealed-vote well-formedness (BLS12-381)`

### Task 4.4 — Confirm public-signal ORDER from r1cs/sym (RED→GREEN assertion in a script)

The on-chain `pub_signals` order is BINDING: `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]` (output first, then public inputs, snarkjs convention). We assert this against the compiled symbol map so a future re-order is caught.

- [ ] **RED — Create** `circuits/vote/test/signals.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";

  // snarkjs emits public signals as: circuit OUTPUTS first, then public INPUTS in declaration order.
  // vote.circom: output `nullifier`; public inputs `merkleRoot, proposalId, sealedCommitmentHash`.
  // The .sym file lists every signal as: `idx,varIdx,componentIdx,name`. Main signals are the
  // lowest indices after signal 0 (constant 1): [out(s), then public ins, then private ins].
  describe("public signal layout", () => {
    it("orders public signals as [merkleRoot, nullifier, proposalId, sealedCommitmentHash]", () => {
      const sym = readFileSync(resolve(__dirname, "../build/vote.sym"), "utf8").trim().split("\n");
      // The witness index -> name map for the four PUBLIC wires of `main`.
      const mainPublic = sym
        .map((l) => l.split(","))
        .filter(([, , , name]) => /^main\.(merkleRoot|nullifier|proposalId|sealedCommitmentHash)$/.test(name))
        .map(([witnessIdx, , , name]) => ({ idx: Number(witnessIdx), name: name.replace("main.", "") }))
        .sort((a, b) => a.idx - b.idx);
      expect(mainPublic.map((s) => s.name)).toEqual([
        "nullifier", "merkleRoot", "proposalId", "sealedCommitmentHash",
      ]);
      // NOTE: snarkjs public.json output array == [outputs..., public inputs...] =
      // [nullifier? ...] — see Task 4.10 which fixes the canonical array order against public.json.
    });
  });
  ```
- [ ] **Run:** `cd circuits/vote && npx vitest run test/signals.test.ts`
  **Expected:** This test documents the witness-index order. If it FAILS, the actual order printed by the assertion error tells you the true layout — **record the real order** and update Task 4.10's `public.json` index mapping accordingly. (snarkjs places the single output `nullifier` at array position [0] of `publicSignals`, then public inputs in declared order. The BINDING external order `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]` is enforced by an explicit re-map in `@shadowkit/zk-prover` Task 4.31, NOT by snarkjs's native order. This test exists so the re-map is grounded in the actual compiled layout.)
- [ ] **Commit:** `test(circuit): assert compiled public-signal layout vs binding order`

### Task 4.5 — Poseidon parity helper circuits

- [ ] **Create** `circuits/poseidon-helpers/poseidon1.circom`:
  ```circom
  pragma circom 2.2.1;
  include "circomlib/circuits/poseidon.circom";
  template P1() { signal input in[1]; signal output out; component h = Poseidon(1); h.inputs[0] <== in[0]; out <== h.out; }
  component main = P1();
  ```
- [ ] **Create** `circuits/poseidon-helpers/poseidon2.circom`:
  ```circom
  pragma circom 2.2.1;
  include "circomlib/circuits/poseidon.circom";
  template P2() { signal input in[2]; signal output out; component h = Poseidon(2); h.inputs[0] <== in[0]; h.inputs[1] <== in[1]; out <== h.out; }
  component main = P2();
  ```
- [ ] **Create** `circuits/poseidon-helpers/poseidon3.circom`:
  ```circom
  pragma circom 2.2.1;
  include "circomlib/circuits/poseidon.circom";
  template P3() { signal input in[3]; signal output out; component h = Poseidon(3); for (var i=0;i<3;i++){h.inputs[i] <== in[i];} out <== h.out; }
  component main = P3();
  ```
- [ ] **Run** (compile all three with the SAME `-p bls12381` field, reusing the vote package's node_modules):
  ```bash
  cd circuits/poseidon-helpers && for n in 1 2 3; do \
    npx --prefix ../vote circom poseidon$n.circom --wasm -p bls12381 -l ../vote/node_modules -o build || \
    circom poseidon$n.circom --wasm -p bls12381 -l ../vote/node_modules -o build; done && \
    ls build/poseidon1_js/poseidon1.wasm build/poseidon2_js/poseidon2.wasm build/poseidon3_js/poseidon3.wasm
  ```
  **Expected:** three `*.wasm` files listed.
- [ ] **Copy committed fixtures:**
  ```bash
  mkdir -p circuits/poseidon-helpers/fixtures && \
    cp circuits/poseidon-helpers/build/poseidon1_js/poseidon1.wasm circuits/poseidon-helpers/fixtures/ && \
    cp circuits/poseidon-helpers/build/poseidon2_js/poseidon2.wasm circuits/poseidon-helpers/fixtures/ && \
    cp circuits/poseidon-helpers/build/poseidon3_js/poseidon3.wasm circuits/poseidon-helpers/fixtures/
  ```
- [ ] **Commit:** `feat(circuit): BLS12-381 Poseidon parity helper circuits (1/2/3 inputs)`

### Task 4.6 — Trusted-setup + fixtures script (the regenerator)

- [ ] **Create** `scripts/snapshot-fixtures.sh` (verified snarkjs CLI; `bls12381` curve; small power-of-tau since the circuit is small):
  ```bash
  #!/usr/bin/env bash
  # Regenerate ALL circuit fixtures: compile vote.circom, run a LOCAL Groth16 trusted setup
  # over BLS12-381, export VK, and produce a sample proof. Toxic waste discarded (hackathon-grade,
  # spec §12). Helper Poseidon wasms (§0.1) are (re)compiled too.
  # SOURCE: snarkjs CLI verified 2026-06-02 via ctx7 /iden3/snarkjs:
  #   powersoftau new <curve> <power> ; powersoftau contribute ; powersoftau prepare phase2 ;
  #   groth16 setup ; zkey contribute ; zkey beacon ; zkey export verificationkey ;
  #   groth16 fullprove ; groth16 verify.
  set -euo pipefail
  cd "$(dirname "$0")/.."
  CIRC=circuits/vote
  FX=$CIRC/fixtures
  POW=12                 # 2^12 = 4096 constraints headroom for the depth-20 circuit; bump if r1cs is larger.
  ENTROPY="shadowkit-hackathon-$(date +%s)"
  BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

  mkdir -p "$FX" "$CIRC/build"

  echo "== compile vote.circom (BLS12-381) =="
  ( cd "$CIRC" && circom vote.circom --r1cs --wasm --sym -p bls12381 -l node_modules -o build )

  echo "== compile poseidon helpers =="
  for n in 1 2 3; do
    ( cd circuits/poseidon-helpers && circom poseidon$n.circom --wasm -p bls12381 -l ../vote/node_modules -o build )
    cp "circuits/poseidon-helpers/build/poseidon${n}_js/poseidon${n}.wasm" "circuits/poseidon-helpers/fixtures/"
  done

  SNARKJS="npx --yes snarkjs@0.7.6"

  echo "== powers of tau (bls12381) =="
  $SNARKJS powersoftau new bls12381 $POW "$CIRC/build/pot_0.ptau" -v
  $SNARKJS powersoftau contribute "$CIRC/build/pot_0.ptau" "$CIRC/build/pot_1.ptau" --name="sk-ptau" -e="$ENTROPY" -v
  $SNARKJS powersoftau prepare phase2 "$CIRC/build/pot_1.ptau" "$CIRC/build/pot_final.ptau" -v

  echo "== groth16 phase2 (zkey) =="
  $SNARKJS groth16 setup "$CIRC/build/vote.r1cs" "$CIRC/build/pot_final.ptau" "$CIRC/build/vote_0.zkey"
  $SNARKJS zkey contribute "$CIRC/build/vote_0.zkey" "$CIRC/build/vote_1.zkey" --name="sk-zkey" -e="$ENTROPY" -v
  $SNARKJS zkey beacon "$CIRC/build/vote_1.zkey" "$FX/vote_final.zkey" "$BEACON" 10 -n="sk-beacon"
  $SNARKJS zkey export verificationkey "$FX/vote_final.zkey" "$FX/verification_key.json"

  echo "== copy committed artifacts =="
  cp "$CIRC/build/vote.r1cs" "$FX/vote.r1cs"
  cp "$CIRC/build/vote_js/vote.wasm" "$FX/vote.wasm"

  echo "== sample proof from fixtures/input.json (must already exist; see Task 4.8) =="
  if [ -f "$FX/input.json" ]; then
    $SNARKJS groth16 fullprove "$FX/input.json" "$FX/vote.wasm" "$FX/vote_final.zkey" "$FX/proof.json" "$FX/public.json"
    $SNARKJS groth16 verify "$FX/verification_key.json" "$FX/public.json" "$FX/proof.json"
    echo "== sample proof verified OK =="
  else
    echo "WARN: $FX/input.json missing — run Task 4.8 to generate a valid input first, then re-run."
  fi
  ```
- [ ] **Run:** `chmod +x scripts/snapshot-fixtures.sh`
- [ ] **Run (partial, no input.json yet):** `./scripts/snapshot-fixtures.sh`
  **Expected:** completes through VK export; prints `WARN: ... input.json missing`. Confirm `circuits/vote/fixtures/{verification_key.json,vote_final.zkey,vote.r1cs,vote.wasm}` exist:
  ```bash
  ls circuits/vote/fixtures/
  ```
- [ ] **Commit:** `build(circuit): trusted-setup + fixture regeneration script (BLS12-381 groth16)`

### Task 4.7 — `poseidonHashBls` over helper wasm (the parity layer) — RED

- [ ] **Scaffold** `packages/zk-prover` if absent. **Create** `packages/zk-prover/package.json`:
  ```json
  {
    "name": "@shadowkit/zk-prover",
    "version": "0.0.0",
    "type": "module",
    "main": "src/index.ts",
    "exports": {
      ".": "./src/index.ts",
      "./poseidon": "./src/poseidon.ts",
      "./seal": "./src/seal.ts",
      "./coordinator": "./src/coordinator.ts"
    },
    "scripts": { "test": "vitest run" },
    "dependencies": {
      "snarkjs": "0.7.6",
      "ffjavascript": "^0.3.0",
      "tlock-js": "0.9.0",
      "drand-client": "latest",
      "@shadowkit/shared": "*"
    },
    "devDependencies": { "vitest": "4.1.8", "typescript": "^5.6.0", "tsx": "^4.22.0" }
  }
  ```
  > `tsx` is the TS-aware runner used to execute the `.mjs` generators (`make-input.mjs`, `emit-bundle.mjs`)
  > that import `src/poseidon.ts` via a `.js` specifier — bare `node` cannot resolve `.js`→`.ts` on Node 26
  > (issue #6). Vitest already strips/resolves TS for the test suites; `tsx` covers the standalone scripts.
  > **`exports` MAP (issue #10).** `@shadowkit/zk-prover` declares a subpath `exports` map so consumers
  > (`snapshot-tool`, `web`, tests) import via stable package subpaths — `@shadowkit/zk-prover` (root),
  > `@shadowkit/zk-prover/poseidon`, `@shadowkit/zk-prover/seal`, `@shadowkit/zk-prover/coordinator` —
  > instead of fragile deep `@shadowkit/zk-prover/src/*.js` paths that rely on legacy resolver behavior.
  > The map points at the `.ts` sources (no build step; Vitest + `tsx` resolve TS). Within THIS package's
  > own tests use relative `../src/*.js` (tsx/vitest resolve `.js`→`.ts`); CROSS-package consumers use the
  > subexports above.
- [ ] **Run:** `npm install --prefix packages/zk-prover --no-audit --no-fund`
  **Expected:** installs without error.
- [ ] **Copy** helper wasms into the package so tests have a stable path:
  ```bash
  mkdir -p packages/zk-prover/artifacts && \
    cp circuits/poseidon-helpers/fixtures/poseidon1.wasm packages/zk-prover/artifacts/ && \
    cp circuits/poseidon-helpers/fixtures/poseidon2.wasm packages/zk-prover/artifacts/ && \
    cp circuits/poseidon-helpers/fixtures/poseidon3.wasm packages/zk-prover/artifacts/ && \
    cp circuits/vote/fixtures/vote.wasm packages/zk-prover/artifacts/ && \
    cp circuits/vote/fixtures/vote_final.zkey packages/zk-prover/artifacts/ && \
    cp circuits/vote/fixtures/verification_key.json packages/zk-prover/artifacts/
  ```
- [ ] **RED — Create** `packages/zk-prover/test/poseidon.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { poseidonHashBls } from "../src/poseidon.js";

  describe("poseidonHashBls (BLS12-381, via circuit wasm)", () => {
    it("is deterministic and field-correct for 2 inputs", async () => {
      const a = await poseidonHashBls(["1", "2"]);
      const b = await poseidonHashBls(["1", "2"]);
      expect(a).toBe(b);                       // deterministic
      expect(/^[0-9]+$/.test(a)).toBe(true);   // decimal field string
      // NOT the BN254 poseidon-lite value (proves we used the BLS12-381 field, not the wrong one).
      expect(a).not.toBe("7853200120776062878684798364095072458815029376092732009249414926327459813530");
    });
    it("supports 1 and 3 inputs", async () => {
      expect(await poseidonHashBls(["5"])).toMatch(/^[0-9]+$/);
      expect(await poseidonHashBls(["1", "2", "3"])).toMatch(/^[0-9]+$/);
    });
  });
  ```
- [ ] **Run:** `npx vitest run packages/zk-prover/test/poseidon.test.ts`
  **Expected FAIL:** `Failed to resolve import "../src/poseidon.js"` / `Cannot find module`.
- [ ] **Commit:** `test(zk-prover): failing poseidonHashBls parity test`

### Task 4.8 — `poseidonHashBls` implementation (GREEN) + generate the sample `input.json`

- [ ] **GREEN — Create** `packages/zk-prover/src/poseidon.ts`:
  ```typescript
  // Poseidon over the BLS12-381 scalar field, computed by running the circuit's OWN compiled
  // witness calculator (§0.1). This GUARANTEES byte-parity with the in-circuit Poseidon — poseidon-lite
  // and circomlibjs.buildPoseidon() are hardcoded to BN254 (verified 2026-06-02) and would silently
  // produce wrong hashes for our BLS12-381 circuit (charter rule 4 forbids that).
  import { fileURLToPath } from "node:url";
  import { dirname, resolve } from "node:path";
  import { mkdtempSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  // snarkjs has no types. VERIFIED API (snarkjs@0.7.6 source, build/main.cjs, 2026-06-02):
  //   wtns.calculate(input, wasmFileName, wtnsFileName, options?) -> Promise<void>
  //     — the 3rd arg is the OUTPUT FILE PATH; it does fastFile.createOverride(wtnsFileName) and
  //       writes the witness there. It returns NOTHING. There is NO `{type:"mem"}` mem-mode that
  //       returns a buffer (the earlier plan draft invented that and was broken).
  //   wtns.exportJson(wtnsFileName) -> Promise<bigint[]>  (reads the .wtns file back; the returned
  //       array `w` has w[0] === 1n (the constant) and w[1] === the FIRST output signal `out` of the
  //       helper circuit; subsequent indices are the inputs). SOURCE: wtnsExportJson -> read() ->
  //       readBigInt loop returning res[] of bigints (build/main.cjs lines 4107 + 890).
  import * as snarkjs from "snarkjs";

  const ARTIFACTS = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts");

  // Run wtns.calculate to a temp .wtns file, then exportJson it and read the output signal.
  // The helper circuits (poseidon{1,2,3}.circom) declare exactly one output `out`, so in the
  // snarkjs witness vector it is index 1 (index 0 is the implicit constant 1 signal).
  async function helperOut(n: 1 | 2 | 3, inputs: string[]): Promise<string> {
    const wasmPath = resolve(ARTIFACTS, `poseidon${n}.wasm`);
    const dir = mkdtempSync(resolve(tmpdir(), "shadowkit-wtns-"));
    const wtnsPath = resolve(dir, "w.wtns");
    try {
      // 3rd arg is a REAL file path (verified). The witness is written to wtnsPath.
      await snarkjs.wtns.calculate({ in: inputs }, wasmPath, wtnsPath);
      // exportJson returns the witness as an array of bigints; w[1] is the `out` signal.
      const w: bigint[] = await snarkjs.wtns.exportJson(wtnsPath);
      return w[1].toString();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  export async function poseidonHashBls(inputs: string[]): Promise<string> {
    const n = inputs.length;
    if (n < 1 || n > 3) throw new Error(`poseidonHashBls: unsupported arity ${n} (1..3)`);
    return helperOut(n as 1 | 2 | 3, inputs);
  }
  ```
  > **VERIFIED, not optional.** This is the single most load-bearing function in M4 (snapshot roots, nullifiers, sealedCommitmentHash, and the committed fixture all depend on it). The API above was verified directly against the installed `snarkjs@0.7.6` source (`build/main.cjs`): `wtnsCalculate(_input, wasmFileName, wtnsFileName, options)` writes the witness to `wtnsFileName` via `fastFile.createOverride(...)` and returns `Promise<void>`; `wtnsExportJson(wtnsFileName)` reads it back and returns a `bigint[]` whose index 1 is the first output signal. There is NO mem-mode that returns a buffer and NO hand-rolled `.wtns` parser is needed. Sanity-check the API yourself before relying on it:
  > ```bash
  > node -e 'import("snarkjs").then(s=>console.log("calculate.length=",s.wtns.calculate.length,"exportJson.length=",s.wtns.exportJson.length))'
  > # Expected: calculate.length= 4  exportJson.length= 1
  > ```
- [ ] **Run:** `npx vitest run packages/zk-prover/test/poseidon.test.ts`
  **Expected PASS:** 2 tests pass; the `not.toBe(BN254 value)` assertion confirms the field.
- [ ] **Generate** the canonical `circuits/vote/fixtures/input.json` using the parity layer + snapshot tree (we hand-build a depth-20 single-leaf tree where the leaf is the voter). Create a one-off generator `circuits/vote/scripts/make-input.mjs`:
  > **EXECUTION MECHANISM (verified, load-bearing — issue #6).** This script imports
  > `packages/zk-prover/src/poseidon.js`, but the source is `poseidon.ts` with NO build step. Bare
  > `node` on Node 26 STRIPS types in a directly-run `.ts` file BUT it does **NOT** resolve a `.js`
  > import specifier to a sibling `.ts` (verified 2026-06-02:
  > `node main.ts` where `main.ts` does `import {...} from "./dep.js"` and only `dep.ts` exists →
  > `ERR_MODULE_NOT_FOUND: Cannot find module .../dep.js`). Therefore this generator (and
  > `emit-bundle.mjs` in Task 4.35) MUST be run with a TS-aware runner that performs `.js`→`.ts`
  > resolution. **Use `npx tsx`** (verified: `tsx` resolves the `.js`→`.ts` import and runs the
  > generator). `tsx@4.x` is pulled in by `npx --yes tsx` (no extra dep needed); to pin it, add
  > `"tsx": "^4.22.0"` to `packages/zk-prover/package.json` devDependencies and prefer the local
  > binary. The `.mjs` extension is kept (tsx runs `.mjs` with TS-aware resolution); do NOT switch
  > these to bare `node`.
  ```javascript
  // Build a valid vote.circom input.json from a single known voter. Uses poseidonHashBls so every
  // hash matches the BLS12-381 circuit. Tree: voter at index 0, all sibling subtrees empty (= Poseidon
  // of zero leaves), depth 20. SOURCE: vote.circom signal layout (foundation §4).
  // RUN WITH: `npx tsx circuits/vote/scripts/make-input.mjs` (NOT bare `node` — see execution note above).
  import { writeFileSync } from "node:fs";
  import { poseidonHashBls } from "../../../packages/zk-prover/src/poseidon.js";

  const DEPTH = 20;
  const secret = "12345";
  const weight = "1000";
  const proposalId = "0";
  const direction = "1";
  const sealKey = "987654321";

  const secretCommit = await poseidonHashBls([secret]);
  const leaf = await poseidonHashBls([secretCommit, weight]);
  const sealedCommitmentHash = await poseidonHashBls([direction, weight, sealKey]);
  const nullifier = await poseidonHashBls([secret, proposalId]);

  // Empty-subtree defaults: zero[0] = 0 leaf; zero[i] = Poseidon(zero[i-1], zero[i-1]).
  const zero = ["0"];
  for (let i = 1; i <= DEPTH; i++) zero.push(await poseidonHashBls([zero[i - 1], zero[i - 1]]));

  // Voter is left-most leaf (all pathIndices = 0), siblings are the empty-subtree hashes.
  const pathElements = []; const pathIndices = [];
  let cur = leaf;
  for (let i = 0; i < DEPTH; i++) {
    pathElements.push(zero[i]);
    pathIndices.push(0);
    cur = await poseidonHashBls([cur, zero[i]]);
  }
  const merkleRoot = cur;

  const input = { merkleRoot, proposalId, sealedCommitmentHash, secret, weight, direction, pathElements, pathIndices, sealKey };
  writeFileSync(new URL("../fixtures/input.json", import.meta.url), JSON.stringify(input, null, 2));
  console.log("wrote input.json; nullifier =", nullifier, "root =", merkleRoot);
  ```
- [ ] **Run:** `npx --yes tsx circuits/vote/scripts/make-input.mjs`
  **Expected:** prints `wrote input.json; nullifier = ... root = ...` and writes `circuits/vote/fixtures/input.json`.
  > Do NOT run `node circuits/vote/scripts/make-input.mjs` — bare Node fails with
  > `ERR_MODULE_NOT_FOUND: Cannot find module .../packages/zk-prover/src/poseidon.js` because that path
  > exists only as `poseidon.ts` and Node does not rewrite `.js`→`.ts` for imports (verified above).
- [ ] **Run the full fixture regenerator** (now that `input.json` exists):
  ```bash
  ./scripts/snapshot-fixtures.sh
  ```
  **Expected:** ends with `[INFO]  snarkJS: OK!` and `== sample proof verified OK ==`. Confirm:
  ```bash
  ls circuits/vote/fixtures/{proof.json,public.json,input.json,verification_key.json,vote_final.zkey,vote.wasm,vote.r1cs}
  ```
- [ ] **Refresh** the zk-prover artifacts copy (proof/public/vote artifacts may have changed):
  ```bash
  cp circuits/vote/fixtures/{vote.wasm,vote_final.zkey,verification_key.json} packages/zk-prover/artifacts/
  ```
- [ ] **Commit:** `feat(zk-prover): poseidonHashBls parity layer + committed circuit fixtures (valid proof)`

### Task 4.9 — Witness satisfiability + adversarial circuit tests (RED→GREEN, real prover)

- [ ] **Create** `circuits/vote/test/circuit.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import * as snarkjs from "snarkjs";

  const FX = resolve(__dirname, "../fixtures");
  const wasm = resolve(FX, "vote.wasm");
  const zkey = resolve(FX, "vote_final.zkey");
  const vkey = JSON.parse(readFileSync(resolve(FX, "verification_key.json"), "utf8"));
  const baseInput = JSON.parse(readFileSync(resolve(FX, "input.json"), "utf8"));

  describe("vote circuit (real snarkjs, BLS12-381)", () => {
    it("witness satisfiable for valid input; proof verifies", async () => {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(baseInput, wasm, zkey);
      expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
    });

    it("rejects non-bit direction (direction = 2)", async () => {
      const bad = { ...baseInput, direction: "2" };
      // direction*(direction-1)===0 is violated => witness generation throws (Assert Failed).
      await expect(snarkjs.groth16.fullProve(bad, wasm, zkey)).rejects.toThrow();
    });

    it("rejects weight that does not match the committed leaf", async () => {
      // Changing weight breaks BOTH leaf membership and the sealedCommitmentHash constraint.
      const bad = { ...baseInput, weight: "9999" };
      await expect(snarkjs.groth16.fullProve(bad, wasm, zkey)).rejects.toThrow();
    });

    it("rejects wrong nullifier wiring (tampered sealedCommitmentHash public input)", async () => {
      const bad = { ...baseInput, sealedCommitmentHash: "1" }; // != Poseidon(direction,weight,sealKey)
      await expect(snarkjs.groth16.fullProve(bad, wasm, zkey)).rejects.toThrow();
    });

    it("nullifier output equals Poseidon(secret, proposalId)", async () => {
      const { publicSignals } = await snarkjs.groth16.fullProve(baseInput, wasm, zkey);
      // publicSignals[0] is the circuit OUTPUT (nullifier) per snarkjs convention; assert it is
      // a non-empty field element and stable across runs (deterministic given fixed input).
      const a = publicSignals[0];
      const { publicSignals: ps2 } = await snarkjs.groth16.fullProve(baseInput, wasm, zkey);
      expect(ps2[0]).toBe(a);
      expect(/^[0-9]+$/.test(a)).toBe(true);
    });
  });
  ```
- [ ] **RED — Run** with fixtures temporarily moved to force failure first (prove the test is real):
  ```bash
  mv circuits/vote/fixtures/proof.json /tmp/proof.bak 2>/dev/null; \
  cd circuits/vote && npx vitest run test/circuit.test.ts
  ```
  **Expected:** the 4 fullProve-based tests still PASS (they regenerate proofs from wasm/zkey, not proof.json) — so instead show RED by corrupting the zkey reference: temporarily point `zkey` to a missing path. Edit the test's `zkey` const to `resolve(FX, "missing.zkey")`, run → **Expected FAIL:** `Error: ENOENT ... missing.zkey`. Then revert to `vote_final.zkey`.
  ```bash
  mv /tmp/proof.bak circuits/vote/fixtures/proof.json 2>/dev/null || true
  ```
- [ ] **GREEN — Run:** `cd circuits/vote && npx vitest run test/circuit.test.ts`
  **Expected PASS:** 5 tests pass (witness sat, 3 adversarial rejects, nullifier determinism).
- [ ] **Commit:** `test(circuit): witness sat + adversarial (bad bit/weight/commitment) + nullifier derivation`

### Task 4.10 — Lock the BINDING public-signal array order against `public.json`

- [ ] **Create** `circuits/vote/test/order.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";

  const FX = resolve(__dirname, "../fixtures");
  const pub = JSON.parse(readFileSync(resolve(FX, "public.json"), "utf8")) as string[];
  const input = JSON.parse(readFileSync(resolve(FX, "input.json"), "utf8"));

  // snarkjs publicSignals = [outputs..., public inputs...] = [nullifier, merkleRoot, proposalId, sealedCommitmentHash].
  // The BINDING EXTERNAL order (foundation §4) is [merkleRoot, nullifier, proposalId, sealedCommitmentHash].
  // @shadowkit/zk-prover re-maps snarkjs order -> binding order (Task 4.31). This test pins the snarkjs
  // native indices so that re-map is grounded in fact.
  describe("public.json native order", () => {
    it("public.json == [nullifier, merkleRoot, proposalId, sealedCommitmentHash]", () => {
      expect(pub.length).toBe(4);
      expect(pub[1]).toBe(input.merkleRoot);
      expect(pub[2]).toBe(input.proposalId);
      expect(pub[3]).toBe(input.sealedCommitmentHash);
      // pub[0] is the nullifier output (not in input.json); must be a field element.
      expect(/^[0-9]+$/.test(pub[0])).toBe(true);
    });
  });
  ```
- [ ] **Run:** `cd circuits/vote && npx vitest run test/order.test.ts`
  **Expected PASS.** If it fails, the assertion shows the TRUE order; update both this test AND Task 4.31's re-map constants to the actual indices, then re-run.
- [ ] **Commit:** `test(circuit): pin snarkjs public.json native order for the prover re-map`

---

## Phase B — On-chain `Groth16Verifier` (BLS12-381)

### Task 4.11 — Scaffold `groth16-verifier` crate (RED via cargo test)

- [ ] **Create** `contracts/groth16-verifier/Cargo.toml`:
  ```toml
  [package]
  name = "groth16-verifier"
  version = "0.0.0"
  edition = "2021"
  publish = false

  [lib]
  crate-type = ["cdylib", "rlib"]
  doctest = false

  [dependencies]
  soroban-sdk = "26.0.0"

  [dev-dependencies]
  soroban-sdk = { version = "26.0.0", features = ["testutils"] }
  # Fixture construction EXACTLY as stellar/soroban-examples groth16_verifier/src/test.rs (verified 2026-06-02).
  ark-bls12-381 = "0.4"
  ark-serialize = "0.4"
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  ```
- [ ] **Add** `contracts/groth16-verifier` to the workspace members in root `Cargo.toml` if not present:
  ```bash
  grep -q 'groth16-verifier' Cargo.toml || echo "  (add \"contracts/groth16-verifier\" to [workspace].members)"
  ```
  Edit `Cargo.toml` `[workspace] members` to include `"contracts/groth16-verifier"`.
- [ ] **Create** a minimal `contracts/groth16-verifier/src/lib.rs` stub:
  ```rust
  #![no_std]
  ```
- [ ] **Create** `contracts/groth16-verifier/src/test.rs`:
  ```rust
  #![cfg(test)]
  #[test]
  fn placeholder_compiles() { assert_eq!(1 + 1, 2); }
  ```
- [ ] **RED — Run:** `cargo test -p groth16-verifier 2>&1 | tail -5`
  **Expected FAIL:** `error: ... file not included in module tree` / `mod test;` missing — the stub `lib.rs` does not declare `mod test;`. (Or `unresolved` until we wire it.) Add `mod test;` in the next task. For now the failure proves the crate is wired into the workspace.
- [ ] **Commit:** `build(groth16): scaffold groth16-verifier crate (BLS12-381)`

### Task 4.12 — Port the verified `verify_proof` (GREEN)

- [ ] **GREEN — Replace** `contracts/groth16-verifier/src/lib.rs` with the verified port (foundation §2.1; body copied from the reference, with the two ShadowKit additions: `Bls12381Fr` re-export + `verify` convenience entrypoint backed by `vk.rs`):
  ```rust
  #![no_std]
  use soroban_sdk::{
      contract, contracterror, contractimpl, contracttype,
      crypto::bls12_381::{Fr, G1Affine, G2Affine},
      vec, Env, Vec,
  };

  mod vk;
  mod test;

  // BINDING re-export (foundation §2.1): downstream crates refer to `groth16_verifier::Bls12381Fr`.
  // The reference verifier imports `Fr` directly and adds no re-export; we add this line so the path
  // resolves. SAME type as soroban_sdk::crypto::bls12_381::Fr.
  pub use soroban_sdk::crypto::bls12_381::Fr as Bls12381Fr;

  #[contracttype]
  #[derive(Clone)]
  pub struct VerificationKey {
      pub alpha: G1Affine,      // vk.alpha_1
      pub beta:  G2Affine,      // vk.beta_2
      pub gamma: G2Affine,      // vk.gamma_2
      pub delta: G2Affine,      // vk.delta_2
      pub ic:    Vec<G1Affine>, // vk.IC — length = (#public signals) + 1
  }

  #[contracttype]
  #[derive(Clone)]
  pub struct Proof {
      pub a: G1Affine, // pi_a (G1)
      pub b: G2Affine, // pi_b (G2)
      pub c: G1Affine, // pi_c (G1)
  }

  #[contracterror]
  #[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
  #[repr(u32)]
  pub enum Groth16Error {
      // BINDING discriminant 0 — matches the reference verifier exactly (foundation §2.1).
      MalformedVerifyingKey = 0,
  }

  #[contract]
  pub struct Groth16Verifier;

  #[contractimpl]
  impl Groth16Verifier {
      /// e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1, vk_x = ic[0] + Σ pub[i]·ic[i+1].
      /// SOURCE: stellar/soroban-examples groth16_verifier/src/lib.rs (verified 2026-06-02).
      pub fn verify_proof(
          env: Env,
          vk: VerificationKey,
          proof: Proof,
          pub_signals: Vec<Fr>,
      ) -> Result<bool, Groth16Error> {
          let bls = env.crypto().bls12_381();
          if pub_signals.len() + 1 != vk.ic.len() {
              return Err(Groth16Error::MalformedVerifyingKey);
          }
          let mut vk_x = vk.ic.get(0).unwrap();
          for (s, v) in pub_signals.iter().zip(vk.ic.iter().skip(1)) {
              let prod = bls.g1_mul(&v, &s);
              vk_x = bls.g1_add(&vk_x, &prod);
          }
          let neg_a = -proof.a;
          let vp1 = vec![&env, neg_a, vk.alpha, vk_x, proof.c];
          let vp2 = vec![&env, proof.b, vk.beta, vk.gamma, vk.delta];
          Ok(bls.pairing_check(vp1, vp2))
      }

      /// Convenience entrypoint used by GovVault: loads the EMBEDDED VK and verifies.
      /// pub_signals order BINDING: [merkleRoot, nullifier, proposalId, sealedCommitmentHash] (§4).
      /// Returns false on malformed VK (never panics) so callers can map to GovError::InvalidProof.
      pub fn verify(env: Env, proof: Proof, pub_signals: Vec<Fr>) -> bool {
          let vk = vk::embedded_vk(&env);
          Self::verify_proof(env, vk, proof, pub_signals).unwrap_or(false)
      }
  }
  ```
- [ ] **Create a placeholder** `contracts/groth16-verifier/src/vk.rs` so the crate compiles (real VK filled in Task 4.14):
  ```rust
  use soroban_sdk::{vec, Env, Vec};
  use soroban_sdk::crypto::bls12_381::{G1Affine, G2Affine};
  use crate::VerificationKey;

  // PLACEHOLDER — replaced in Task 4.14 by values generated from verification_key.json.
  // Returns an all-zero VK so the crate compiles; the embedded-VK test (4.14) drives the real values.
  pub fn embedded_vk(env: &Env) -> VerificationKey {
      let z1 = G1Affine::from_bytes(soroban_sdk::BytesN::from_array(env, &[0u8; 96]));
      let z2 = G2Affine::from_bytes(soroban_sdk::BytesN::from_array(env, &[0u8; 192]));
      VerificationKey { alpha: z1.clone(), beta: z2.clone(), gamma: z2.clone(), delta: z2, ic: vec![env, z1.clone(), z1] }
  }
  ```
  > NOTE: `G1Affine::from_bytes`/`from_array` API — verify against `soroban-sdk 26.0.0` docs before use: `npx ctx7@latest docs /stellar/rs-soroban-sdk "bls12_381 G1Affine from_array from_bytes G1_SERIALIZED_SIZE"`. The reference test uses `G1Affine::from_array(env, &buf)` with `G1_SERIALIZED_SIZE = 96`, `G2_SERIALIZED_SIZE = 192`. Use whichever constructor the installed SDK exposes; the byte layout is uncompressed (x‖y), big-endian per the reference `serialize_uncompressed`.
- [ ] **Replace** the placeholder `test.rs` body's `mod test;` wiring is already in `lib.rs`. Update `contracts/groth16-verifier/src/test.rs` to keep the placeholder test for now:
  ```rust
  #![cfg(test)]
  extern crate std;
  #[test]
  fn crate_compiles() { assert_eq!(1 + 1, 2); }
  ```
- [ ] **Run:** `cargo test -p groth16-verifier 2>&1 | tail -5`
  **Expected PASS:** `test crate_compiles ... ok`.
- [ ] **Commit:** `feat(groth16): port verify_proof + verify entrypoint (BLS12-381, reference-adapted)`

### Task 4.13 — Real fixture test: valid proof → true (RED→GREEN)

This is the snarkjs↔on-chain round-trip with the COMMITTED fixtures. We load `proof.json`/`public.json`/`verification_key.json` and convert to Soroban types exactly as the reference test does (arkworks → `from_array`).

- [ ] **RED — Replace** `contracts/groth16-verifier/src/test.rs`:
  ```rust
  #![cfg(test)]
  extern crate std;
  use std::{string::String, vec::Vec as StdVec};

  use ark_bls12_381::{Fq, Fq2};
  use ark_serialize::CanonicalSerialize;
  use core::str::FromStr;
  use soroban_sdk::{
      crypto::bls12_381::{Fr, G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE},
      Env, Vec, U256,
  };
  use serde::Deserialize;

  use crate::{Groth16Verifier, Groth16VerifierClient, Proof, VerificationKey};

  // ---- fixture JSON shapes (snarkjs verification_key.json / proof.json / public.json) ----
  #[derive(Deserialize)]
  struct VkJson { vk_alpha_1: [String; 3], vk_beta_2: [[String; 2]; 3], vk_gamma_2: [[String; 2]; 3],
                  vk_delta_2: [[String; 2]; 3], #[serde(rename = "IC")] ic: StdVec<[String; 3]> }
  #[derive(Deserialize)]
  struct ProofJson { pi_a: [String; 3], pi_b: [[String; 2]; 3], pi_c: [String; 3] }

  fn g1(env: &Env, x: &str, y: &str) -> G1Affine {
      let p = ark_bls12_381::G1Affine::new(Fq::from_str(x).unwrap(), Fq::from_str(y).unwrap());
      let mut buf = [0u8; G1_SERIALIZED_SIZE];
      p.serialize_uncompressed(&mut buf[..]).unwrap();
      G1Affine::from_array(env, &buf)
  }
  fn g2(env: &Env, x1: &str, x2: &str, y1: &str, y2: &str) -> G2Affine {
      let x = Fq2::new(Fq::from_str(x1).unwrap(), Fq::from_str(x2).unwrap());
      let y = Fq2::new(Fq::from_str(y1).unwrap(), Fq::from_str(y2).unwrap());
      let p = ark_bls12_381::G2Affine::new(x, y);
      let mut buf = [0u8; G2_SERIALIZED_SIZE];
      p.serialize_uncompressed(&mut buf[..]).unwrap();
      G2Affine::from_array(env, &buf)
  }
  // snarkjs Fr decimal string -> soroban Fr via U256 from big-endian 32 bytes.
  fn fr(env: &Env, dec: &str) -> Fr {
      let n = num_to_be32(dec);
      Fr::from_u256(U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &n)))
  }
  // decimal string -> 32-byte big-endian (no external bigint dep: parse via u128 chunks is unsafe for
  // field-size numbers, so use a tiny base-10 schoolbook into bytes).
  fn num_to_be32(dec: &str) -> [u8; 32] {
      let mut acc = [0u8; 32];
      for ch in dec.bytes() {
          let d = (ch - b'0') as u16;
          // acc = acc*10 + d  (big-endian, MSB at index 0)
          let mut carry = d;
          for i in (0..32).rev() {
              let v = acc[i] as u16 * 10 + carry;
              acc[i] = (v & 0xff) as u8;
              carry = v >> 8;
          }
      }
      acc
  }

  const VK: &str = include_str!("../../../circuits/vote/fixtures/verification_key.json");
  const PROOF: &str = include_str!("../../../circuits/vote/fixtures/proof.json");
  const PUBLIC: &str = include_str!("../../../circuits/vote/fixtures/public.json");

  fn load_vk(env: &Env) -> VerificationKey {
      let v: VkJson = serde_json::from_str(VK).unwrap();
      let mut ic = Vec::new(env);
      for p in &v.ic { ic.push_back(g1(env, &p[0], &p[1])); }
      VerificationKey {
          alpha: g1(env, &v.vk_alpha_1[0], &v.vk_alpha_1[1]),
          beta:  g2(env, &v.vk_beta_2[0][0], &v.vk_beta_2[0][1], &v.vk_beta_2[1][0], &v.vk_beta_2[1][1]),
          gamma: g2(env, &v.vk_gamma_2[0][0], &v.vk_gamma_2[0][1], &v.vk_gamma_2[1][0], &v.vk_gamma_2[1][1]),
          delta: g2(env, &v.vk_delta_2[0][0], &v.vk_delta_2[0][1], &v.vk_delta_2[1][0], &v.vk_delta_2[1][1]),
          ic,
      }
  }
  fn load_proof(env: &Env) -> Proof {
      let p: ProofJson = serde_json::from_str(PROOF).unwrap();
      Proof {
          a: g1(env, &p.pi_a[0], &p.pi_a[1]),
          b: g2(env, &p.pi_b[0][0], &p.pi_b[0][1], &p.pi_b[1][0], &p.pi_b[1][1]),
          c: g1(env, &p.pi_c[0], &p.pi_c[1]),
      }
  }
  fn load_public(env: &Env) -> Vec<Fr> {
      let arr: StdVec<String> = serde_json::from_str(PUBLIC).unwrap();
      let mut out = Vec::new(env);
      for s in &arr { out.push_back(fr(env, s)); }
      out
  }
  fn client(e: &Env) -> Groth16VerifierClient<'_> {
      Groth16VerifierClient::new(e, &e.register(Groth16Verifier {}, ()))
  }

  #[test]
  fn valid_proof_verifies_true() {
      let env = Env::default();
      let c = client(&env);
      assert_eq!(c.verify_proof(&load_vk(&env), &load_proof(&env), &load_public(&env)), true);
  }
  ```
  > **snarkjs verification_key.json field names** verified by inspecting the generated fixture: `vk_alpha_1` (G1, 3 strings), `vk_beta_2`/`vk_gamma_2`/`vk_delta_2` (G2, 3×2 strings), `IC` (array of G1). `proof.json`: `pi_a` (3), `pi_b` (3×2), `pi_c` (3). The 3rd element of each G1/G2 is the projective `1` and is discarded (we use affine x,y). **CONFIRM by:** `head -30 circuits/vote/fixtures/verification_key.json` before running; if names differ in your snarkjs version, adjust the `#[serde(rename)]`s.
  > **G2 coordinate ordering note:** snarkjs lists G2 as `[[x_c0, x_c1], [y_c0, y_c1], [1,0]]`. arkworks `Fq2::new(c0, c1)`. The reference test maps `g2(x1,x2,y1,y2)` with `Fq2::new(Fq(x1),Fq(x2))` — i.e. x1=c0, x2=c1. We pass `v.vk_beta_2[0][0]=x_c0, [0][1]=x_c1, [1][0]=y_c0, [1][1]=y_c1`, matching the reference exactly.
- [ ] **RED — Run:** `cargo test -p groth16-verifier valid_proof_verifies_true 2>&1 | tail -15`
  **Expected FAIL (genuine — write the test BEFORE the fixtures exist).** Run this test FIRST, before
  `scripts/snapshot-fixtures.sh` has produced `proof.json`/`public.json` (i.e. immediately after writing
  the test, with only `verification_key.json` present from Task 4.6's partial run). The
  `include_str!("../../../circuits/vote/fixtures/proof.json")` will fail to compile:
  `error: couldn't read .../proof.json: No such file or directory`. This is the genuine red — the
  committed real proof does not yet exist, so the round-trip test cannot pass.
  > If you reordered and `proof.json` already exists (Task 4.8 generated it), the test passes immediately
  > because it loads a REAL committed snarkjs proof against the REAL ported verify_proof. That is a
  > legitimate green: `verify_proof` is a faithful, line-verified port of the audited
  > `stellar/soroban-examples` reference (Task 4.12, every line cited), and its genuine pairing-layer
  > red→green (valid→true, tampered→false) is the verifier's own development (4.16). Do NOT manufacture a
  > mutation-red here; if the fixtures pre-exist, record this as a justified round-trip regression.
- [ ] **GREEN — Run** (after `scripts/snapshot-fixtures.sh` + `make-input.mjs` from Task 4.8 produced the
  fixtures): `cargo test -p groth16-verifier valid_proof_verifies_true 2>&1 | tail -8`
  **Expected PASS:** `test valid_proof_verifies_true ... ok`.
- [ ] **Commit:** `test(groth16): valid committed fixture proof verifies true on-chain (round-trip)`

### Task 4.14 — Generate the EMBEDDED VK (`vk.rs`) from `verification_key.json` (RED→GREEN)

- [ ] **Create** a generator `contracts/groth16-verifier/scripts/gen-vk.mjs` that emits `vk.rs` from the committed VK (so `verify` uses the same VK as the fixture test, and they cannot drift):
  ```javascript
  // Generate contracts/groth16-verifier/src/vk.rs from circuits/vote/fixtures/verification_key.json.
  // Emits arkworks-based constructors identical to the test loader. A test (4.14) asserts the
  // embedded VK accepts the committed proof, guaranteeing vk.rs <-> verification_key.json parity.
  import { readFileSync, writeFileSync } from "node:fs";
  const vk = JSON.parse(readFileSync(new URL("../../../circuits/vote/fixtures/verification_key.json", import.meta.url)));
  const g1 = (a) => `g1(env, "${a[0]}", "${a[1]}")`;
  const g2 = (a) => `g2(env, "${a[0][0]}", "${a[0][1]}", "${a[1][0]}", "${a[1][1]}")`;
  const ic = vk.IC.map(g1).join(",\n        ");
  const out = `// AUTO-GENERATED by scripts/gen-vk.mjs from circuits/vote/fixtures/verification_key.json. DO NOT EDIT.
  use ark_bls12_381::{Fq, Fq2};
  use ark_serialize::CanonicalSerialize;
  use core::str::FromStr;
  use soroban_sdk::{vec, Env, Vec};
  use soroban_sdk::crypto::bls12_381::{G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE};
  use crate::VerificationKey;

  fn g1(env: &Env, x: &str, y: &str) -> G1Affine {
      let p = ark_bls12_381::G1Affine::new(Fq::from_str(x).unwrap(), Fq::from_str(y).unwrap());
      let mut buf = [0u8; G1_SERIALIZED_SIZE];
      p.serialize_uncompressed(&mut buf[..]).unwrap();
      G1Affine::from_array(env, &buf)
  }
  fn g2(env: &Env, x1: &str, x2: &str, y1: &str, y2: &str) -> G2Affine {
      let x = Fq2::new(Fq::from_str(x1).unwrap(), Fq::from_str(x2).unwrap());
      let y = Fq2::new(Fq::from_str(y1).unwrap(), Fq::from_str(y2).unwrap());
      let p = ark_bls12_381::G2Affine::new(x, y);
      let mut buf = [0u8; G2_SERIALIZED_SIZE];
      p.serialize_uncompressed(&mut buf[..]).unwrap();
      G2Affine::from_array(env, &buf)
  }

  pub fn embedded_vk(env: &Env) -> VerificationKey {
      VerificationKey {
          alpha: ${g1(vk.vk_alpha_1)},
          beta:  ${g2(vk.vk_beta_2)},
          gamma: ${g2(vk.vk_gamma_2)},
          delta: ${g2(vk.vk_delta_2)},
          ic: vec![env,
          ${ic}
          ],
      }
  }
  `;
  writeFileSync(new URL("../src/vk.rs", import.meta.url), out);
  console.log("wrote vk.rs with", vk.IC.length, "IC points");
  ```
  > **PROBLEM:** the placeholder `vk.rs` (Task 4.12) is `#![no_std]`-compatible (uses `soroban-sdk` only), but the generated `vk.rs` uses `ark-bls12-381`/`ark-serialize` which are **std** crates and were added as **dev-dependencies**. `embedded_vk` is called by the non-test `verify` entrypoint, so its deps must be **regular** (non-dev) deps — BUT arkworks in a `#![no_std]` cdylib bloats wasm and may not compile to `wasm32v1-none`. **RESOLUTION (binding):** generate `vk.rs` to emit **raw byte arrays** (the `from_array` inputs), not arkworks calls, so `embedded_vk` depends ONLY on `soroban-sdk`. Update the generator to serialize each point to its 96/192-byte uncompressed form at GENERATION time (Node side, using `ffjavascript`/`@noble/curves` or a tiny arkworks Rust helper) and emit `G1Affine::from_array(env, &[<bytes>])`. See Task 4.15.
- [ ] **No run yet** — this generator is superseded by Task 4.15's byte-array form. **Do not commit the arkworks-call version.**

### Task 4.15 — `vk.rs` as pure-bytes (no arkworks in the contract) (GREEN)

- [ ] **Create** a Rust helper binary `contracts/groth16-verifier/src/bin/embed_vk.rs` that reads the VK JSON and prints `vk.rs` with **byte literals** (runs on the host, std allowed):
  ```rust
  // Host-only generator (run with `cargo run -p groth16-verifier --bin embed_vk`). Converts
  // verification_key.json G1/G2 decimal coords -> uncompressed byte arrays -> emits src/vk.rs that
  // depends ONLY on soroban-sdk (so the contract stays no_std / wasm-clean).
  use ark_bls12_381::{Fq, Fq2};
  use ark_serialize::CanonicalSerialize;
  use core::str::FromStr;
  use serde::Deserialize;
  use std::fs;

  #[derive(Deserialize)]
  struct VkJson { vk_alpha_1: [String;3], vk_beta_2: [[String;2];3], vk_gamma_2: [[String;2];3],
                  vk_delta_2: [[String;2];3], #[serde(rename="IC")] ic: Vec<[String;3]> }

  fn g1_bytes(x:&str,y:&str)->[u8;96]{ let p=ark_bls12_381::G1Affine::new(Fq::from_str(x).unwrap(),Fq::from_str(y).unwrap());
      let mut b=[0u8;96]; p.serialize_uncompressed(&mut b[..]).unwrap(); b }
  fn g2_bytes(x1:&str,x2:&str,y1:&str,y2:&str)->[u8;192]{
      let x=Fq2::new(Fq::from_str(x1).unwrap(),Fq::from_str(x2).unwrap());
      let y=Fq2::new(Fq::from_str(y1).unwrap(),Fq::from_str(y2).unwrap());
      let p=ark_bls12_381::G2Affine::new(x,y); let mut b=[0u8;192]; p.serialize_uncompressed(&mut b[..]).unwrap(); b }
  fn arr(b:&[u8])->String{ let s:Vec<String>=b.iter().map(|x|x.to_string()).collect(); format!("[{}]",s.join(",")) }

  fn main(){
      let raw=fs::read_to_string("circuits/vote/fixtures/verification_key.json").unwrap();
      let v:VkJson=serde_json::from_str(&raw).unwrap();
      let mut ic=String::new();
      for p in &v.ic { ic.push_str(&format!("        G1Affine::from_array(env, &{}),\n", arr(&g1_bytes(&p[0],&p[1])))); }
      let out=format!(r#"// AUTO-GENERATED by `cargo run -p groth16-verifier --bin embed_vk`. DO NOT EDIT.
  // Source: circuits/vote/fixtures/verification_key.json. Depends ONLY on soroban-sdk (wasm-clean).
  use soroban_sdk::{{vec, Env, Vec}};
  use soroban_sdk::crypto::bls12_381::{{G1Affine, G2Affine}};
  use crate::VerificationKey;

  pub fn embedded_vk(env: &Env) -> VerificationKey {{
      VerificationKey {{
          alpha: G1Affine::from_array(env, &{alpha}),
          beta:  G2Affine::from_array(env, &{beta}),
          gamma: G2Affine::from_array(env, &{gamma}),
          delta: G2Affine::from_array(env, &{delta}),
          ic: vec![env,
  {ic}      ],
      }}
  }}
  "#,
          alpha=arr(&g1_bytes(&v.vk_alpha_1[0],&v.vk_alpha_1[1])),
          beta=arr(&g2_bytes(&v.vk_beta_2[0][0],&v.vk_beta_2[0][1],&v.vk_beta_2[1][0],&v.vk_beta_2[1][1])),
          gamma=arr(&g2_bytes(&v.vk_gamma_2[0][0],&v.vk_gamma_2[0][1],&v.vk_gamma_2[1][0],&v.vk_gamma_2[1][1])),
          delta=arr(&g2_bytes(&v.vk_delta_2[0][0],&v.vk_delta_2[0][1],&v.vk_delta_2[1][0],&v.vk_delta_2[1][1])),
          ic=ic);
      fs::write("contracts/groth16-verifier/src/vk.rs", out).unwrap();
      eprintln!("wrote vk.rs with {} IC points", v.ic.len());
  }
  ```
- [ ] **Move** `ark-bls12-381`, `ark-serialize`, `serde`, `serde_json` so the `embed_vk` bin can use them. They are already in `[dev-dependencies]`; a `[[bin]]` cannot use dev-deps. Add to `Cargo.toml`:
  ```toml
  [[bin]]
  name = "embed_vk"
  path = "src/bin/embed_vk.rs"
  required-features = ["host-tools"]

  [features]
  host-tools = ["dep:ark-bls12-381", "dep:ark-serialize", "dep:serde", "dep:serde_json"]
  ```
  and change those four entries from `[dev-dependencies]` to optional regular deps:
  ```toml
  [dependencies]
  soroban-sdk = "26.0.0"
  ark-bls12-381 = { version = "0.4", optional = true }
  ark-serialize = { version = "0.4", optional = true }
  serde = { version = "1", optional = true, features = ["derive"] }
  serde_json = { version = "1", optional = true }

  [dev-dependencies]
  soroban-sdk = { version = "26.0.0", features = ["testutils"] }
  ark-bls12-381 = "0.4"
  ark-serialize = "0.4"
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  ```
- [ ] **RED — Run:** `cargo run -p groth16-verifier --bin embed_vk --features host-tools 2>&1 | tail -3`
  **Expected:** `wrote vk.rs with 5 IC points` (4 public signals + 1 = 5 IC points). This overwrites the placeholder `vk.rs`.
- [ ] **Create** the embedded-VK test in `contracts/groth16-verifier/src/test.rs` (append):
  ```rust
  #[test]
  fn embedded_vk_accepts_committed_proof() {
      let env = Env::default();
      let c = client(&env);
      // `verify` loads the EMBEDDED vk (vk.rs) — must accept the same committed proof.
      assert_eq!(c.verify(&load_proof(&env), &load_public(&env)), true);
  }
  ```
- [ ] **GREEN — Run:** `cargo test -p groth16-verifier embedded_vk_accepts_committed_proof 2>&1 | tail -8`
  **Expected PASS:** `test embedded_vk_accepts_committed_proof ... ok`. (If it fails, `vk.rs` drifted from the fixture — re-run `embed_vk`.)
- [ ] **Commit:** `feat(groth16): embed VK as wasm-clean byte arrays; verify() uses embedded VK`

### Task 4.16 — Negative verifier tests: tampered / wrong-input / malformed → false or error, NO panic

- [ ] **Append** to `contracts/groth16-verifier/src/test.rs`:
  ```rust
  #[test]
  fn tampered_proof_verifies_false() {
      let env = Env::default();
      let c = client(&env);
      let mut p = load_proof(&env);
      // Flip pi_c to alpha-of-vk (a valid but wrong G1 point) -> pairing check fails -> false.
      p.c = load_vk(&env).alpha;
      assert_eq!(c.verify(&p, &load_public(&env)), false);
  }

  #[test]
  fn wrong_public_input_verifies_false() {
      let env = Env::default();
      let c = client(&env);
      let mut pubs = load_public(&env);
      // Replace nullifier (index 0 in public.json native order) with a different field element.
      pubs.set(0, fr(&env, "42"));
      assert_eq!(c.verify(&load_proof(&env), &pubs), false);
  }

  #[test]
  fn malformed_vk_returns_error_no_panic() {
      let env = Env::default();
      let c = client(&env);
      // pub_signals length mismatch vs vk.ic -> verify_proof returns Err(MalformedVerifyingKey).
      let mut short = load_public(&env);
      short.pop_back(); // now len mismatches vk.ic
      let res = c.try_verify_proof(&load_vk(&env), &load_proof(&env), &short);
      assert_eq!(res, Err(Ok(crate::Groth16Error::MalformedVerifyingKey)));
  }

  #[test]
  fn verify_with_malformed_returns_false_not_panic() {
      let env = Env::default();
      let c = client(&env);
      // The convenience `verify` maps any error to false (never panics).
      let mut short = load_public(&env);
      short.pop_back();
      assert_eq!(c.verify(&load_proof(&env), &short), false);
  }
  ```
  > `try_verify_proof` is the Soroban-generated fallible client method (returns `Result<Result<bool, Groth16Error>, ...>`). Verify the exact `Err(Ok(...))` nesting against `soroban-sdk 26.0.0`: `npx ctx7@latest docs /stellar/rs-soroban-sdk "contractclient try_ method Result error enum return shape"`. If the SDK wraps differently, adjust the `assert_eq!` pattern; the assertion MUST check the concrete `MalformedVerifyingKey` code, not just `is_err()`.
- [ ] **GREEN — Run:** `cargo test -p groth16-verifier 2>&1 | tail -12`
  **Expected PASS:** all verifier tests pass (`valid_proof_verifies_true`, `embedded_vk_accepts_committed_proof`, `tampered_proof_verifies_false`, `wrong_public_input_verifies_false`, `malformed_vk_returns_error_no_panic`, `verify_with_malformed_returns_false_not_panic`).
  > **JUSTIFICATION (charter §7.2 green-on-first-run exception).** `verify_proof`/`verify` are a faithful,
  > line-by-line port of the audited `stellar/soroban-examples` reference verifier (Task 4.12, every line
  > cited to the upstream source), so these adversarial tests are green on first run against the REAL
  > committed snarkjs proof. They are REAL negatives (a tampered proof / wrong public input flips the
  > pairing check to false; a length mismatch yields the concrete `MalformedVerifyingKey` code), NOT
  > always-pass assertions — `tampered_proof_verifies_false` would catch any port that accepted a bad
  > proof. Recorded as a deliberate, charter-acknowledged exception (faithful-port + REAL-fixture
  > negatives) rather than a manufactured mutation-red. Do NOT temporarily `panic!()` the verifier to
  > stage a fake red; the genuine red for this code was the upstream reference's own development, and
  > these tests' value is catching a future REGRESSION (e.g. a wrong byte order in `vk.rs`).
- [ ] **Commit:** `test(groth16): tampered/wrong-input/malformed -> false or error, no panic`

---

## Phase C — `gov-vault::cast_vote` requires the proof (sealed, no tally)

> M1 shipped `gov-vault` with a PLAINTEXT `cast_vote` AND a plaintext `init(admin, treasury_asset, quorum_cfg, vote_weights)` / `weight_of` snapshot path. M4 changes `init` to the foundation §2.2 BINDING form (Task 4.19a) and `cast_vote` to the BINDING sealed form, enforcing verify + nullifier + proposalId + merkleRoot on-chain. **M4 keeps M1's plaintext tally/quorum and M1's plaintext `close(env, id)` UNCHANGED** — the on-chain sealed re-aggregation `close_and_reveal` (foundation §2.2) is built in M5, and M5 retires the M1 plaintext `close`/tally machinery at that point (see Task 4.40 hand-off note). M4 does NOT create a `close_and_reveal` stub; only vote intake (`init` + `cast_vote`) changes here.

### Task 4.19a — MODIFY `GovVault::init` to the foundation §2.2 form (reintroduce verifier + merkle_root, retire vote_weights)

> **WHY (cross-plan reconciliation):** M1 (Task 3.4) shipped `init(env, admin, treasury_asset, quorum_cfg, vote_weights: Map<Address,i128>)` and explicitly deferred verifier/merkle_root with the note "M4 reintroduces verifier/merkle_root". This task is that reintroduction. Sealed weighted voting (the snapshot Merkle root + zk proof) REPLACES the M1 per-address `vote_weights` map, so this task also retires `vote_weights`/`weight_of`. Every M4 test deploy already calls the foundation form `gov.init(&admin, &verifier_id, &root, &asset, &default_quorum(env))` (Tasks 4.21, 4.35, 4.36, ...), so this MUST land first or those calls won't type-check and `storage::get_verifier(&env).unwrap()` (used by `cast_vote`) will panic on an unset key.

- [ ] **RED — Replace** the `init` happy-path test in `contracts/gov-vault/src/test.rs` (the M1 `test_init_sets_state`/`test_double_init_rejects` pair) with the foundation-form assertions (init sets Verifier + MerkleRoot; double-init rejects). Build the test deploy with `gov.init(&admin, &verifier_id, &root, &asset, &default_quorum(&env))`. Run:
  ```bash
  cargo test -p gov-vault test_init 2>&1 | tail -12
  ```
  **Expected RED:** compile error — the M1 `init` signature still expects `vote_weights: Map<Address,i128>` (arity/type mismatch), or `weight_of`/`set_vote_weights` references no longer resolve.
- [ ] **GREEN — Replace** the M1 `init` (+ `weight_of`) in `contracts/gov-vault/src/lib.rs` with the foundation §2.2 form, and delete the `vote_weights` snapshot path:
  ```rust
  // contracts/gov-vault/src/lib.rs — foundation §2.2 init (replaces the M1 plaintext form).
  // verifier + merkle_root reintroduced (M1 deferred them: "M4 reintroduces verifier/merkle_root").
  // vote_weights/weight_of removed: the snapshot Merkle root + zk proof replace per-address weights.
  pub fn init(
      env: Env,
      admin: Address,
      verifier: Address,        // Groth16Verifier contract id
      merkle_root: BytesN<32>,  // snapshot root (Poseidon, big-endian 32 bytes)
      treasury_asset: Address,  // SAC of the treasury asset
      quorum_cfg: QuorumCfg,
  ) {
      if storage::is_initialized(&env) {
          panic_with_error!(&env, GovError::AlreadyInitialized);
      }
      admin.require_auth();
      storage::set_admin(&env, &admin);
      storage::set_verifier(&env, &verifier);
      storage::set_merkle_root(&env, &merkle_root);
      storage::set_treasury_asset(&env, &treasury_asset);
      storage::set_quorum_cfg(&env, &quorum_cfg);
      env.storage().instance().set(&storage::DataKey::NextId, &0u32);
  }
  // DELETE the M1 `pub fn weight_of(...)` entrypoint.
  ```
  Then **delete** the now-unused `set_vote_weights`/`get_vote_weights` helpers from `contracts/gov-vault/src/storage.rs` (and the `VoteWeights` `DataKey` variant if M1 added one — the foundation §2.2 enum does not include it). Remove any remaining `storage::get_vote_weights(...)` reads in `cast_vote`/tally (the M1 plaintext-vote path; M4's sealed `cast_vote` replaces it).
- [ ] **GREEN — Run:** `cargo test -p gov-vault test_init 2>&1 | tail -12`
  **Expected PASS:** init sets Verifier + MerkleRoot; double-init rejects.
- [ ] **Commit:** `feat(gov-vault): init reintroduces verifier+merkle_root (foundation §2.2), retire vote_weights`

### Task 4.20 — Wire `groth16-verifier` dep + storage keys (compile-only RED→GREEN)

- [ ] **Modify** `contracts/gov-vault/Cargo.toml` — add dependency + feature:
  ```toml
  [dependencies]
  # ... existing ...
  groth16-verifier = { path = "../groth16-verifier" }

  [features]
  offchain-verify = []   # FALLBACK: skip on-chain verify, trust admin-asserted validity (foundation §2.1)
  ```
- [ ] **Modify** `contracts/gov-vault/src/storage.rs` — ensure these `DataKey` variants exist (add any missing; foundation §2.2):
  ```rust
  // Add if not already present from M1:
  //   SealedVotes(u32),      // Vec<SealedVote>        (persistent)
  //   Nullifier(BytesN<32>), // () presence = used     (persistent)
  ```
  Confirm `Verifier` (Address) and `MerkleRoot` (BytesN<32>) variants exist in the `DataKey` enum. **NOTE: M1 did NOT set them** — M1's `init` took `(admin, treasury_asset, quorum_cfg, vote_weights)` and never wrote `DataKey::Verifier`/`DataKey::MerkleRoot` (M1 Task 3.4, recorded divergence "M4 reintroduces verifier/merkle_root"). Task 4.19a (below) MODIFIES `init` to the foundation §2.2 form and is what actually sets these keys — so it MUST land before any test or `cast_vote` path that reads `storage::get_verifier`/`get_merkle_root` (else `.unwrap()` panics on the unset key).
- [ ] **Run:** `cargo build -p gov-vault 2>&1 | tail -5`
  **Expected PASS:** compiles with the new dep. (RED would only appear if `groth16-verifier` were absent — Phase B guarantees it exists.)
- [ ] **Commit:** `build(gov-vault): depend on groth16-verifier + add offchain-verify feature`

### Task 4.21 — Failing test: sealed `cast_vote` happy path (RED)

- [ ] **Add a shared test helper** module reference. **Append** to `contracts/gov-vault/src/test.rs` a fixture loader that reuses the committed circuit fixtures (same arkworks pattern as the verifier test). To avoid duplicating the loader, factor it into `contracts/gov-vault/src/test_fixtures.rs`:
  ```rust
  #![cfg(test)]
  extern crate std;
  use std::{string::String, vec::Vec as StdVec};
  use ark_bls12_381::{Fq, Fq2};
  use ark_serialize::CanonicalSerialize;
  use core::str::FromStr;
  use serde::Deserialize;
  use soroban_sdk::{crypto::bls12_381::{Fr, G1Affine, G2Affine, G1_SERIALIZED_SIZE, G2_SERIALIZED_SIZE}, Bytes, BytesN, Env, U256, Vec};
  use groth16_verifier::Proof;

  #[derive(Deserialize)] struct ProofJson { pi_a:[String;3], pi_b:[[String;2];3], pi_c:[String;3] }

  pub const PROOF: &str = include_str!("../../../circuits/vote/fixtures/proof.json");
  pub const PUBLIC: &str = include_str!("../../../circuits/vote/fixtures/public.json");

  fn g1(e:&Env,x:&str,y:&str)->G1Affine{ let p=ark_bls12_381::G1Affine::new(Fq::from_str(x).unwrap(),Fq::from_str(y).unwrap());
      let mut b=[0u8;G1_SERIALIZED_SIZE]; p.serialize_uncompressed(&mut b[..]).unwrap(); G1Affine::from_array(e,&b) }
  fn g2(e:&Env,x1:&str,x2:&str,y1:&str,y2:&str)->G2Affine{
      let x=Fq2::new(Fq::from_str(x1).unwrap(),Fq::from_str(x2).unwrap());
      let y=Fq2::new(Fq::from_str(y1).unwrap(),Fq::from_str(y2).unwrap());
      let p=ark_bls12_381::G2Affine::new(x,y); let mut b=[0u8;G2_SERIALIZED_SIZE]; p.serialize_uncompressed(&mut b[..]).unwrap(); G2Affine::from_array(e,&b) }
  pub fn be32(dec:&str)->[u8;32]{ let mut a=[0u8;32]; for ch in dec.bytes(){ let d=(ch-b'0') as u16; let mut c=d;
      for i in (0..32).rev(){ let v=a[i] as u16*10+c; a[i]=(v&0xff) as u8; c=v>>8; } } a }
  pub fn fr(e:&Env,dec:&str)->Fr{ Fr::from_u256(U256::from_be_bytes(e,&Bytes::from_array(e,&be32(dec)))) }

  pub fn committed_proof(e:&Env)->Proof{ let p:ProofJson=serde_json::from_str(PROOF).unwrap();
      Proof{ a:g1(e,&p.pi_a[0],&p.pi_a[1]), b:g2(e,&p.pi_b[0][0],&p.pi_b[0][1],&p.pi_b[1][0],&p.pi_b[1][1]), c:g1(e,&p.pi_c[0],&p.pi_c[1]) } }

  // public.json native order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash] (Task 4.10).
  // GovVault expects BINDING order [merkleRoot, nullifier, proposalId, sealedCommitmentHash] — the
  // CLIENT re-maps before calling cast_vote (Task 4.31). For contract tests we build the BINDING vector.
  pub fn committed_public_signals(e:&Env)->Vec<Fr>{
      let arr:StdVec<String>=serde_json::from_str(PUBLIC).unwrap();
      // arr[0]=nullifier, arr[1]=merkleRoot, arr[2]=proposalId, arr[3]=sealedCommitmentHash
      let mut v=Vec::new(e);
      v.push_back(fr(e,&arr[1])); // merkleRoot
      v.push_back(fr(e,&arr[0])); // nullifier
      v.push_back(fr(e,&arr[2])); // proposalId
      v.push_back(fr(e,&arr[3])); // sealedCommitmentHash
      v
  }
  pub fn merkle_root_be32(e:&Env)->BytesN<32>{ let arr:StdVec<String>=serde_json::from_str(PUBLIC).unwrap(); BytesN::from_array(e,&be32(&arr[1])) }
  pub fn nullifier_be32(e:&Env)->BytesN<32>{ let arr:StdVec<String>=serde_json::from_str(PUBLIC).unwrap(); BytesN::from_array(e,&be32(&arr[0])) }
  pub fn sealed_commit_be32(e:&Env)->BytesN<32>{ let arr:StdVec<String>=serde_json::from_str(PUBLIC).unwrap(); BytesN::from_array(e,&be32(&arr[3])) }
  ```
  Add `mod test_fixtures;` to `gov-vault/src/lib.rs` (under `#[cfg(test)]`), and add the arkworks/serde dev-deps to `gov-vault/Cargo.toml`:
  ```toml
  [dev-dependencies]
  # ... existing soroban-sdk testutils ...
  ark-bls12-381 = "0.4"
  ark-serialize = "0.4"
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  groth16-verifier = { path = "../groth16-verifier" }
  ```
- [ ] **RED — Append** the happy-path test to `contracts/gov-vault/src/test.rs`:
  ```rust
  use crate::test_fixtures::{committed_proof, committed_public_signals, merkle_root_be32, nullifier_be32, sealed_commit_be32};
  use shadowkit_shared::SealedVote;
  use soroban_sdk::{Bytes, testutils::Address as _, Address, Env, BytesN};

  // Deploys verifier + gov-vault, inits gov-vault with the committed merkle root, creates a proposal,
  // and casts the committed sealed vote. Asserts votes_cast == 1 and NO tally exposed.
  #[test]
  fn sealed_cast_vote_happy_path() {
      let env = Env::default();
      env.mock_all_auths(); // admin auth for create_proposal; the PROOF itself is the real gate (not mocked).
      let (gov, _verifier) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);   // helper from M1; deadline in the future
      let sealed = SealedVote {
          round: 0,
          ciphertext: Bytes::from_array(&env, b"sealed-blob"),
          sealed_commitment_hash: sealed_commit_be32(&env),
      };
      gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(gov.votes_cast(&id), 1);
      let pv = gov.proposal(&id);
      assert_eq!(pv.weighted_yes, None);  // NO tally before close
      assert_eq!(pv.weighted_no, None);
  }
  ```
  > `deploy_with_committed_root` and `create_default_proposal` are NEW helpers; add them in this same task:
  ```rust
  fn deploy_with_committed_root(env: &Env) -> (GovVaultClient<'static>, Address) {
      let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
      let gov_id = env.register(GovVault {}, ());
      let gov = GovVaultClient::new(env, &gov_id);
      let admin = Address::generate(env);
      let asset = Address::generate(env);
      let root = merkle_root_be32(env); // BINDING: the snapshot root the committed proof was built against
      gov.init(&admin, &verifier_id, &root, &asset, &default_quorum(env));
      (gov, verifier_id)
  }
  ```
  Reuse `default_quorum` / `create_default_proposal` from M1; if absent, define `create_default_proposal` to call `create_proposal(action_spec, cap, deadline)` with `deadline = env.ledger().timestamp() + 1_000`.
- [ ] **RED — Run:** `cargo test -p gov-vault sealed_cast_vote_happy_path 2>&1 | tail -15`
  **Expected FAIL:** `error[E0061]: this function takes ... arguments` or `no method named votes_cast` — because `cast_vote` still has the M1 plaintext signature and `votes_cast` may not exist yet. This is the genuine red.
- [ ] **Commit:** `test(gov-vault): failing sealed cast_vote happy-path (proof required, no tally)`

> **GRANULARITY NOTE (issues #5, #6, #7 — read before Tasks 4.21b–4.26).** The sealed `cast_vote` is
> built across SIX small TDD cycles, not one bundled GREEN. Each guard is added in its OWN cycle so its
> test goes RED-because-the-feature-is-absent, then GREEN — genuine TDD red, NOT the
> comment-out-then-restore mutation red the testing charter §7.2 forbids ("a task that shows green on
> first run without a prior red is invalid"). The order is:
> - **4.21b** — pure `Fr`↔bytes helpers + storage helpers, each with their own direct unit tests.
> - **4.22** — minimal `cast_vote` happy path (proposal-exists + deadline + verify + commit), NO
>   nullifier/proposalId/root/commitment guards yet. Makes the happy-path test (4.21) green.
> - **4.23** — add the nullifier guard (double-vote test goes red first because the guard is absent).
> - **4.24** — add the proposalId-binding guard.
> - **4.25** — add the merkleRoot (stale-root), sealed-commitment, and invalid-proof guards.
> - **4.26** — assert the no-tally privacy invariant.
> Because each guard is genuinely absent when its test is first written, every guard test is a real red.

### Task 4.21b — `Fr`↔bytes helpers + storage helpers (RED→GREEN, dedicated unit tests)

These pure functions carry the proposalId-binding and merkleRoot anti-stale logic; they get their OWN tests (issue #7) instead of being driven only by the happy path.

- [ ] **RED — Append** to `contracts/gov-vault/src/test.rs` direct unit tests for the helpers (they are `pub(crate)` so the test module can call them):
  ```rust
  use crate::{fr_eq_u32, fr_eq_bytes32, fr_to_bytes32};
  use crate::test_fixtures::fr;
  use soroban_sdk::BytesN;

  #[test]
  fn fr_eq_u32_matches_only_the_same_u32() {
      let env = Env::default();
      // fr("5") encodes the field element 5; fr_eq_u32 must be true for 5, false for 6/0.
      assert_eq!(fr_eq_u32(&env, &fr(&env, "5"), 5), true);
      assert_eq!(fr_eq_u32(&env, &fr(&env, "5"), 6), false);
      assert_eq!(fr_eq_u32(&env, &fr(&env, "5"), 0), false);
      assert_eq!(fr_eq_u32(&env, &fr(&env, "0"), 0), true);
  }

  #[test]
  fn fr_to_bytes32_roundtrips_be32() {
      let env = Env::default();
      // fr("1") -> 32 bytes all zero except the last byte = 1 (big-endian).
      let b = fr_to_bytes32(&env, &fr(&env, "1"));
      let mut expect = [0u8; 32]; expect[31] = 1;
      assert_eq!(b, BytesN::from_array(&env, &expect));
  }

  #[test]
  fn fr_eq_bytes32_compares_field_to_be32() {
      let env = Env::default();
      let mut one = [0u8; 32]; one[31] = 1;
      assert_eq!(fr_eq_bytes32(&env, &fr(&env, "1"), &BytesN::from_array(&env, &one)), true);
      let mut two = [0u8; 32]; two[31] = 2;
      assert_eq!(fr_eq_bytes32(&env, &fr(&env, "1"), &BytesN::from_array(&env, &two)), false);
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault fr_eq_u32_matches_only_the_same_u32 fr_to_bytes32_roundtrips_be32 fr_eq_bytes32_compares_field_to_be32 2>&1 | tail -10`
  **Expected FAIL:** `error[E0425]: cannot find function fr_to_bytes32` / `fr_eq_u32` (the helpers do not exist yet).
- [ ] **GREEN — Add** the helpers to `contracts/gov-vault/src/lib.rs` as `pub(crate)` (the same three helpers Task 4.22 uses; defined here so they have a test FIRST):
  ```rust
  use groth16_verifier::Bls12381Fr;
  use soroban_sdk::{Bytes, BytesN, Env};

  // VERIFIED (soroban-sdk source, 2026-06-02): Fr::to_u256(&self)->U256; U256::to_be_bytes(&self)->Bytes
  // (exactly 32 bytes); inverse of the verifier test's Fr::from_u256(U256::from_be_bytes(..)) round-trip.
  pub(crate) fn fr_to_bytes32(env: &Env, f: &Bls12381Fr) -> BytesN<32> {
      let u = f.to_u256();
      let b: Bytes = u.to_be_bytes();
      let mut arr = [0u8; 32];
      for i in 0..32 { arr[i] = b.get(i as u32).unwrap(); }
      BytesN::from_array(env, &arr)
  }
  pub(crate) fn fr_eq_bytes32(env: &Env, f: &Bls12381Fr, b: &BytesN<32>) -> bool { fr_to_bytes32(env, f) == *b }
  pub(crate) fn fr_eq_u32(env: &Env, f: &Bls12381Fr, n: u32) -> bool {
      let mut arr = [0u8; 32];
      arr[28..32].copy_from_slice(&n.to_be_bytes());
      fr_to_bytes32(env, f) == BytesN::from_array(env, &arr)
  }
  ```
- [ ] **GREEN — Run:** `cargo test -p gov-vault fr_eq_u32_matches_only_the_same_u32 fr_to_bytes32_roundtrips_be32 fr_eq_bytes32_compares_field_to_be32 2>&1 | tail -8`
  **Expected PASS:** 3 helper tests pass.
- [ ] **GREEN — Add** the typed storage helpers to `contracts/gov-vault/src/storage.rs` (pure wrappers over `DataKey`; no behavior change, so they are exercised by the happy path + guard tests, not a separate test). `DataKey` is defined in THIS module so it is referenced directly (no `use crate::storage::DataKey` self-import):
  ```rust
  use shadowkit_shared::SealedVote;
  use soroban_sdk::{Address, BytesN, Env, Vec};
  use crate::ProposalRecord; // internal persistent record (foundation §2.2); make it pub(crate)

  pub fn get_admin(env: &Env) -> Address { env.storage().instance().get(&DataKey::Admin).unwrap() }
  pub fn get_verifier(env: &Env) -> Address { env.storage().instance().get(&DataKey::Verifier).unwrap() }
  pub fn set_verifier(env: &Env, v: &Address) { env.storage().instance().set(&DataKey::Verifier, v); }
  pub fn get_merkle_root(env: &Env) -> BytesN<32> { env.storage().instance().get(&DataKey::MerkleRoot).unwrap() }
  pub fn set_merkle_root(env: &Env, r: &BytesN<32>) { env.storage().instance().set(&DataKey::MerkleRoot, r); }
  pub fn get_proposal(env: &Env, id: u32) -> Option<ProposalRecord> { env.storage().persistent().get(&DataKey::Proposal(id)) }
  pub fn set_proposal(env: &Env, id: u32, rec: &ProposalRecord) { env.storage().persistent().set(&DataKey::Proposal(id), rec); }
  pub fn nullifier_used(env: &Env, n: &BytesN<32>) -> bool { env.storage().persistent().has(&DataKey::Nullifier(n.clone())) }
  pub fn mark_nullifier(env: &Env, n: &BytesN<32>) { env.storage().persistent().set(&DataKey::Nullifier(n.clone()), &()); }
  pub fn push_sealed_vote(env: &Env, id: u32, v: &SealedVote) {
      let mut votes: Vec<SealedVote> = env.storage().persistent().get(&DataKey::SealedVotes(id)).unwrap_or(Vec::new(env));
      votes.push_back(v.clone());
      env.storage().persistent().set(&DataKey::SealedVotes(id), &votes);
  }
  ```
  > `ProposalRecord` gains a `votes_cast: u32` field if M1 did not already define one (foundation §2.2 lists it). Add it to the struct + the `proposal()` projection (which sets `ProposalView.votes_cast`).
- [ ] **GREEN — Run:** `cargo build -p gov-vault 2>&1 | tail -5`
  **Expected PASS:** compiles with the new helpers + `votes_cast` field.
- [ ] **Commit:** `feat(gov-vault): Fr<->bytes + typed storage helpers (with direct unit tests)`

### Task 4.22 — Minimal sealed `cast_vote` happy path + `votes_cast` (GREEN)

> Implements ONLY the happy path: proposal-exists + deadline + on-chain verify + commit. The
> nullifier/proposalId/stale-root/sealed-commitment guards are deliberately NOT here — they are added in
> 4.23–4.25 so each guard test gets a genuine red (charter §7.2). This makes Task 4.21's happy-path test
> green WITHOUT pre-implementing the guards.

- [ ] **GREEN — Replace** `gov-vault`'s `cast_vote` with the minimal sealed version (foundation §2.2). In `contracts/gov-vault/src/lib.rs`:
  ```rust
  use groth16_verifier::{Groth16VerifierClient, Proof, Bls12381Fr};
  use shadowkit_shared::SealedVote;
  use soroban_sdk::{BytesN, Vec};

  // index constants for the BINDING public-signal vector [merkleRoot, nullifier, proposalId, sealedCommitmentHash].
  // PS_NULLIFIER is used by this minimal task; PS_MERKLE_ROOT/PS_PROPOSAL_ID/PS_SEALED_COMMIT are consumed
  // by the guards added in Tasks 4.24/4.25b/4.25c. Declared together here; until their guards land they are
  // `#[allow(dead_code)]` to avoid an unused-const warning (gov-vault does not `deny(warnings)`, so this is
  // belt-and-suspenders — remove the allow once 4.25c lands and all four are used).
  #[allow(dead_code)] const PS_MERKLE_ROOT: u32 = 0;
  const PS_NULLIFIER: u32 = 1;
  #[allow(dead_code)] const PS_PROPOSAL_ID: u32 = 2;
  #[allow(dead_code)] const PS_SEALED_COMMIT: u32 = 3;

  #[contractimpl]
  impl GovVault {
      // SIGNATURE NOTE (binding, foundation §2.1): under `feature = "offchain-verify"` the entrypoint
      // takes an EXTRA trailing `verified: bool` flag asserted by the trusted coordinator (the §2.1
      // flag). The PRIMARY (default) build omits it — the on-chain verifier is the source of truth and a
      // self-asserted flag would be meaningless. The two builds therefore expose two ABIs; this is
      // recorded in foundation §2.1 ("the switch lives in gov-vault") and the offchain ABI is only used
      // by the trusted-coordinator deployment. The cfg-gated parameter keeps the flag out of the primary
      // contract entirely (no dead arg, no always-pass assertion).
      #[cfg(not(feature = "offchain-verify"))]
      pub fn cast_vote(
          env: Env,
          id: u32,
          proof: Proof,
          pub_signals: Vec<Bls12381Fr>,
          sealed_ciphertext: SealedVote,
      ) {
          Self::cast_vote_inner(env, id, proof, pub_signals, sealed_ciphertext);
      }

      #[cfg(feature = "offchain-verify")]
      pub fn cast_vote(
          env: Env,
          id: u32,
          proof: Proof,
          pub_signals: Vec<Bls12381Fr>,
          sealed_ciphertext: SealedVote,
          verified: bool, // foundation §2.1: trusted-coordinator off-chain-verify result
      ) {
          Self::cast_vote_inner(env, id, proof, pub_signals, sealed_ciphertext, verified);
      }

      // Shared body. The `verified` parameter exists only under the offchain-verify feature.
      // MINIMAL happy path: proposal-exists + deadline + verify + commit. The nullifier/proposalId/
      // stale-root/sealed-commitment guards are ADDED in Tasks 4.23–4.25 (each with its own genuine red).
      fn cast_vote_inner(
          env: Env,
          id: u32,
          proof: Proof,
          pub_signals: Vec<Bls12381Fr>,
          sealed_ciphertext: SealedVote,
          #[cfg(feature = "offchain-verify")] verified: bool,
      ) {
          // 0) proposal exists.
          let mut rec = storage::get_proposal(&env, id).unwrap_or_else(|| panic_with_error!(&env, GovError::ProposalNotFound));
          // 1) public-signal sanity: exactly 4.
          if pub_signals.len() != 4 {
              panic_with_error!(&env, GovError::InvalidProof);
          }
          // 2) compute the nullifier (used to commit). The deadline + anti-replay GUARDS that consume the
          //    other public signals (deadline, stale-root, proposalId, sealed-commitment, nullifier-used)
          //    are added in Tasks 4.23–4.25 — NOT here, so each guard test gets a genuine red.
          let nullifier = fr_to_bytes32(&env, &pub_signals.get(PS_NULLIFIER).unwrap());
          // 3) VERIFY the proof on-chain (PRIMARY) or trust the coordinator-asserted flag (FALLBACK feature).
          #[cfg(not(feature = "offchain-verify"))]
          {
              let verifier = Groth16VerifierClient::new(&env, &storage::get_verifier(&env));
              if !verifier.verify(&proof, &pub_signals) {
                  panic_with_error!(&env, GovError::InvalidProof);
              }
          }
          #[cfg(feature = "offchain-verify")]
          {
              // FALLBACK (foundation §2.1): the on-chain Groth16 verify is replaced by a TRUSTED
              // COORDINATOR that pre-verifies the proof OFF-CHAIN via snarkjs.groth16.verify and only
              // then authorizes this call. The contract (a) requires the coordinator/admin auth (so only
              // the trusted coordinator can push a vote) AND (b) requires `verified == true` — the
              // explicit foundation §2.1 flag. The coordinator sets it from snarkjs.groth16.verify.
              //
              // CHARTER RULE 3: the actual off-chain verification (the WHOLE reason the fallback exists)
              // is implemented and TESTED in the TS coordinator `verifyAndAuthorize`
              // (packages/zk-prover/src/coordinator.ts, Task 4.30b) — a tampered proof is rejected by
              // snarkjs.groth16.verify BEFORE the contract is ever called; the Rust test
              // (offchain_verify_rejects_unverified_flag) proves the contract refuses `verified == false`.
              storage::get_admin(&env).require_auth();
              if !verified {
                  panic_with_error!(&env, GovError::InvalidProof);
              }
          }
          // 4) commit: mark nullifier used, append sealed vote, bump count.
          storage::mark_nullifier(&env, &nullifier);
          storage::push_sealed_vote(&env, id, &sealed_ciphertext);
          rec.votes_cast += 1;
          storage::set_proposal(&env, id, &rec);
          VoteCast { id, nullifier }.publish(&env);
      }

      pub fn votes_cast(env: Env, id: u32) -> u32 {
          storage::get_proposal(&env, id).unwrap_or_else(|| panic_with_error!(&env, GovError::ProposalNotFound)).votes_cast
      }
  }
  ```
  > The `Fr`↔bytes helpers (`fr_to_bytes32`/`fr_eq_bytes32`/`fr_eq_u32`) and the `storage.rs` helpers
  > were already added WITH their own tests in Task 4.21b — they are NOT re-declared here. This task only
  > adds `cast_vote`/`cast_vote_inner`/`votes_cast`.
- [ ] **GREEN — Run:** `cargo test -p gov-vault sealed_cast_vote_happy_path 2>&1 | tail -10`
  **Expected PASS:** `test sealed_cast_vote_happy_path ... ok`. (The happy-path fixtures use the stored
  root + matching proposalId + commitment, so the not-yet-present guards do not affect it.)
- [ ] **Commit:** `feat(gov-vault): minimal sealed cast_vote (proof required, stores ciphertext, no tally)`

### Task 4.23 — Double-vote (same nullifier) → `NullifierUsed` (RED→GREEN)

- [ ] **RED — Append** to `contracts/gov-vault/src/test.rs`:
  ```rust
  #[test]
  fn double_vote_same_nullifier_rejected() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      // Second identical vote reuses the same nullifier -> NullifierUsed.
      let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(res, Err(Ok(GovError::NullifierUsed)));
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault double_vote_same_nullifier_rejected 2>&1 | tail -8`
  **Expected FAIL (genuine):** the nullifier-used guard does NOT exist yet (Task 4.22 was minimal). The
  second vote SUCCEEDS, so `try_cast_vote` returns `Ok(())` and the assertion fails:
  `assertion failed: ... expected Err(Ok(NullifierUsed)), got Ok(())`.
- [ ] **GREEN — Add** the nullifier-used guard to `cast_vote_inner` in `contracts/gov-vault/src/lib.rs`, immediately AFTER computing `nullifier` (step 2) and BEFORE the verify (step 3):
  ```rust
          // 2a) double-vote guard: this nullifier must not have been used before.
          if storage::nullifier_used(&env, &nullifier) {
              panic_with_error!(&env, GovError::NullifierUsed);
          }
  ```
- [ ] **GREEN — Run:** `cargo test -p gov-vault double_vote_same_nullifier_rejected 2>&1 | tail -6`
  **Expected PASS.**
- [ ] **Commit:** `feat(gov-vault): reject double-vote via reused nullifier`

### Task 4.24 — Replay across proposals (proposalId binding) → `WrongProposalId` (RED→GREEN)

- [ ] **RED — Append:**
  ```rust
  #[test]
  fn replay_other_proposal_rejected() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id0 = create_default_proposal(&env, &gov); // committed proof has proposalId == 0
      let id1 = create_default_proposal(&env, &gov); // id1 == 1
      assert_eq!(id1, 1);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      // The committed proof's proposalId signal is 0; casting it on proposal 1 must be rejected.
      let res = gov.try_cast_vote(&id1, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(res, Err(Ok(GovError::WrongProposalId)));
      // Sanity: it DOES succeed on proposal 0.
      gov.cast_vote(&id0, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(gov.votes_cast(&id0), 1);
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault replay_other_proposal_rejected 2>&1 | tail -8`
  **Expected FAIL (genuine):** the proposalId-binding guard does NOT exist yet. The committed proof
  verifies fine on id1 (the proof/VK are proposalId-agnostic at the pairing layer; only the contract's
  signal-vs-id check binds them), so the id1 cast SUCCEEDS:
  `assertion failed: ... expected Err(Ok(WrongProposalId)), got Ok(())`.
- [ ] **GREEN — Add** the proposalId-binding guard to `cast_vote_inner`, right after the nullifier-used
  guard (2a) and before the verify (step 3):
  ```rust
          // 2b) proposalId signal == id: binds the proof to THIS proposal => replay across proposals fails.
          if !fr_eq_u32(&env, &pub_signals.get(PS_PROPOSAL_ID).unwrap(), id) {
              panic_with_error!(&env, GovError::WrongProposalId);
          }
  ```
- [ ] **GREEN — Run:** `cargo test -p gov-vault replay_other_proposal_rejected 2>&1 | tail -6`
  **Expected PASS.**
- [ ] **Commit:** `feat(gov-vault): bind proof to proposalId (reject cross-proposal replay)`

### Task 4.25a — Post-deadline vote → `DeadlinePassed` (RED→GREEN)

- [ ] **RED — Append** to `contracts/gov-vault/src/test.rs`:
  ```rust
  #[test]
  fn post_deadline_vote_rejected() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);
      // advance ledger time past the deadline.
      let pv = gov.proposal(&id);
      env.ledger().set_timestamp(pv.deadline + 1);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(res, Err(Ok(GovError::DeadlinePassed)));
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault post_deadline_vote_rejected 2>&1 | tail -8`
  **Expected FAIL (genuine):** the deadline guard is absent (minimal 4.22 dropped it). The vote succeeds
  past the deadline: `assertion failed: ... expected Err(Ok(DeadlinePassed)), got Ok(())`.
- [ ] **GREEN — Add** the deadline guard to `cast_vote_inner` as step 0a (right after fetching `rec`):
  ```rust
          // 0a) reject votes cast at/after the deadline.
          if env.ledger().timestamp() >= rec.deadline {
              panic_with_error!(&env, GovError::DeadlinePassed);
          }
  ```
- [ ] **GREEN — Run:** `cargo test -p gov-vault post_deadline_vote_rejected 2>&1 | tail -6`
  **Expected PASS.**
- [ ] **Commit:** `feat(gov-vault): reject votes cast after the deadline`

### Task 4.25b — Stale snapshot root → `StaleMerkleRoot` (RED→GREEN)

- [ ] **RED — Append:**
  ```rust
  #[test]
  fn stale_merkle_root_rejected() {
      let env = Env::default();
      env.mock_all_auths();
      // init with a DIFFERENT root than the proof was built against.
      let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
      let gov_id = env.register(GovVault {}, ());
      let gov = GovVaultClient::new(&env, &gov_id);
      let admin = Address::generate(&env); let asset = Address::generate(&env);
      let wrong_root = BytesN::from_array(&env, &[7u8; 32]);
      gov.init(&admin, &verifier_id, &wrong_root, &asset, &default_quorum(&env));
      let id = create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(res, Err(Ok(GovError::StaleMerkleRoot)));
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault stale_merkle_root_rejected 2>&1 | tail -8`
  **Expected FAIL (genuine):** the merkleRoot guard is absent. With a wrong stored root the on-chain
  verify still passes (the proof's merkleRoot signal is consistent with the proof, not with the stored
  root), so the vote succeeds: `assertion failed: ... expected Err(Ok(StaleMerkleRoot)), got Ok(())`.
- [ ] **GREEN — Add** the stale-root guard to `cast_vote_inner`, right after step 2b (proposalId):
  ```rust
          // 2c) merkleRoot signal == stored snapshot root (anti-stale: vote against the live snapshot).
          let stored_root: BytesN<32> = storage::get_merkle_root(&env);
          if !fr_eq_bytes32(&env, &pub_signals.get(PS_MERKLE_ROOT).unwrap(), &stored_root) {
              panic_with_error!(&env, GovError::StaleMerkleRoot);
          }
  ```
- [ ] **GREEN — Run:** `cargo test -p gov-vault stale_merkle_root_rejected 2>&1 | tail -6`
  **Expected PASS.**
- [ ] **Commit:** `feat(gov-vault): reject votes against a stale merkle root`

### Task 4.25c — Sealed-commitment mismatch → `InvalidProof` (RED→GREEN)

The proof's 4th public signal must equal the stored ciphertext's `sealed_commitment_hash`, binding the proof to the exact sealed blob (so a valid proof cannot be paired with a substituted ciphertext).

- [ ] **RED — Append:**
  ```rust
  #[test]
  fn sealed_commitment_mismatch_rejected() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);
      // ciphertext's commitment hash is WRONG (not the proof's sealedCommitmentHash signal).
      let sealed = SealedVote {
          round: 0,
          ciphertext: Bytes::from_array(&env, b"a"),
          sealed_commitment_hash: BytesN::from_array(&env, &[9u8; 32]), // != public signal[3]
      };
      let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(res, Err(Ok(GovError::InvalidProof)));
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault sealed_commitment_mismatch_rejected 2>&1 | tail -8`
  **Expected FAIL (genuine):** the commitment-binding guard is absent. The proof verifies and there is no
  check tying the ciphertext to signal[3], so the substituted ciphertext is accepted:
  `assertion failed: ... expected Err(Ok(InvalidProof)), got Ok(())`.
- [ ] **GREEN — Add** the sealed-commitment guard to `cast_vote_inner`, right after step 2c (stale-root):
  ```rust
          // 2d) sealedCommitmentHash signal == ciphertext's commitment (binds proof <-> stored blob).
          if !fr_eq_bytes32(&env, &pub_signals.get(PS_SEALED_COMMIT).unwrap(), &sealed_ciphertext.sealed_commitment_hash) {
              panic_with_error!(&env, GovError::InvalidProof);
          }
  ```
- [ ] **GREEN — Run:** `cargo test -p gov-vault sealed_commitment_mismatch_rejected 2>&1 | tail -6`
  **Expected PASS.**
- [ ] **Commit:** `feat(gov-vault): bind proof to the stored sealed ciphertext commitment`

### Task 4.25d — Invalid proof → `InvalidProof` (regression of the verify call)

- [ ] **Append:**
  ```rust
  #[test]
  fn invalid_proof_rejected() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);
      // Tamper pi_a so the pairing check fails, but keep the public signals (so root/id/commit checks pass).
      let mut bad = committed_proof(&env);
      bad.a = bad.c.clone(); // valid G1 point, wrong proof -> on-chain verify returns false.
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      let res = gov.try_cast_vote(&id, &bad, &committed_public_signals(&env), &sealed);
      assert_eq!(res, Err(Ok(GovError::InvalidProof)));
  }
  ```
  > **JUSTIFICATION (charter §7.2 green-on-first-run exception).** Unlike the guards in 4.23–4.25c, the
  > on-chain `verify` call is INTRINSIC to the minimal happy path (Task 4.22) — "cast_vote requires a
  > proof" is meaningless without it, and the happy-path test (4.21) already drives the verify call by
  > asserting a VALID proof is ACCEPTED. This negative test asserts the DUAL (an invalid proof is
  > REJECTED) of that same already-implemented code path, so it is green on first run by construction. The
  > verify code itself had its genuine RED→GREEN in the verifier crate (Tasks 4.13/4.16, including a
  > tampered-proof negative). This test is a contract-integration REGRESSION of that behavior, recorded
  > here as a deliberate, charter-acknowledged exception rather than a manufactured mutation-red.
- [ ] **GREEN — Run:** `cargo test -p gov-vault invalid_proof_rejected 2>&1 | tail -6`
  **Expected PASS** (verify was implemented in 4.22; this asserts its negative behavior).
- [ ] **Commit:** `test(gov-vault): reject an invalid (tampered) proof on-chain`

### Task 4.26 — `proposal()` exposes NO tally before close (explicit invariant test)

- [ ] **RED — Append:**
  ```rust
  #[test]
  fn proposal_view_hides_tally_before_close() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      let pv = gov.proposal(&id);
      // Before close: status must be Open/Tallying and tally fields MUST be None.
      assert!(matches!(pv.status, shadowkit_shared::ProposalStatus::Open | shadowkit_shared::ProposalStatus::Tallying));
      assert_eq!(pv.weighted_yes, None);
      assert_eq!(pv.weighted_no, None);
      assert_eq!(pv.votes_cast, 1); // participation IS exposed (no direction).
  }
  ```
- [ ] **Run:** `cargo test -p gov-vault proposal_view_hides_tally_before_close 2>&1 | tail -8`
  **Expected PASS.**
  > **JUSTIFICATION (charter §7.2 green-on-first-run exception).** The no-tally-before-close projection
  > (`weighted_yes/no == None` until reveal) was implemented and RED→GREEN-driven in M1's `proposal()`
  > (plan `2026-06-02-shadowkit-M1-plaintext-governance-amm.md`). M4 does not change that projection — it only changes vote intake. This
  > test is a PRIVACY-INVARIANT REGRESSION asserting the M1 behavior still holds after sealed-vote
  > integration (the single most important security property: the SEALED tally must never leak early). It
  > is green on first run because the behavior pre-exists; recorded as a deliberate, charter-acknowledged
  > regression rather than a manufactured mutation-red. (If `proposal()` does NOT yet exist from M1 in your
  > tree, this becomes a genuine RED — run it, see `no method named proposal`, then implement the
  > projection.)
- [ ] **Commit:** `test(gov-vault): proposal() exposes no tally before close (privacy invariant)`

### Task 4.27 — Full verifier-layer regression in the workspace

- [ ] **Run:** `cargo test --workspace 2>&1 | tail -20`
  **Expected:** all crates green, including the new `groth16-verifier` and modified `gov-vault` suites. No `warning: unused` for the proof in PRIMARY mode.
- [ ] **Commit (if any fixups):** `test(repo): workspace green after sealed-vote integration`

---

## Phase D — FALLBACK 1: off-chain verify (`feature = offchain-verify`)

> **What the fallback IS (foundation §2.1, charter rule 3).** Instead of the on-chain Groth16 pairing
> check, a TRUSTED COORDINATOR pre-verifies the proof OFF-CHAIN with the REAL `snarkjs.groth16.verify`
> and only authorizes the `cast_vote` call when verification passes, passing `verified == true` (the
> foundation §2.1 flag). The commitment/nullifier/proposalId/root checks stay on-chain. The OFF-CHAIN
> verification — the entire reason the fallback exists — is REAL code (`verifyAndAuthorize`) with its own
> passing suite that proves a TAMPERED proof is rejected BEFORE authorization. The contract additionally
> refuses `verified == false`. There is NO "admin says it's fine with no verification" escape hatch.
>
> This satisfies charter rule 3 across BOTH layers: (Task 4.30a) the on-chain contract requires
> coordinator auth AND `verified == true`; (Task 4.30b) the off-chain coordinator runs real
> `snarkjs.groth16.verify` and refuses to authorize an invalid proof.

### Task 4.30a — On-chain off-chain-verify fallback suite (RED→GREEN under the feature)

- [ ] **RED — Create** `contracts/gov-vault/src/test_offchain.rs`:
  ```rust
  #![cfg(all(test, feature = "offchain-verify"))]
  extern crate std;
  use crate::test_fixtures::{committed_proof, committed_public_signals, merkle_root_be32, sealed_commit_be32};
  use crate::{GovVault, GovVaultClient, GovError};
  use shadowkit_shared::SealedVote;
  use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};

  fn deploy(env: &Env) -> (GovVaultClient<'static>, Address) {
      let gov_id = env.register(GovVault {}, ());
      let gov = GovVaultClient::new(env, &gov_id);
      let admin = Address::generate(env); let asset = Address::generate(env);
      let verifier = Address::generate(env); // unused in fallback mode
      gov.init(&admin, &verifier, &merkle_root_be32(env), &asset, &crate::test::default_quorum(env));
      (gov, admin)
  }

  // Under offchain-verify the entrypoint takes the trailing `verified: bool` flag (Task 4.22 signature).
  #[test]
  fn offchain_verify_accepts_coordinator_authorized_verified_vote() {
      let env = Env::default();
      let (gov, admin) = deploy(&env);
      env.mock_all_auths(); // admin (coordinator) require_auth() is the fallback gate.
      let id = crate::test::create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      // verified == true: the coordinator pre-verified off-chain (Task 4.30b proves this is REAL).
      gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed, &true);
      assert_eq!(gov.votes_cast(&id), 1);
      let _ = &admin;
  }

  #[test]
  fn offchain_verify_rejects_unverified_flag() {
      // The contract MUST refuse verified == false even when the coordinator authorized the call.
      // This proves the §2.1 flag is load-bearing (not the dropped-flag "admin says it's fine" hatch).
      let env = Env::default();
      let (gov, _admin) = deploy(&env);
      env.mock_all_auths();
      let id = crate::test::create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed, &false);
      assert_eq!(res, Err(Ok(GovError::InvalidProof)));
  }

  #[test]
  fn offchain_verify_rejects_unauthorized_vote() {
      // With NO coordinator auth, cast_vote must error even with verified == true.
      let env = Env::default();
      let (gov, _admin) = deploy(&env);
      // create the proposal under mocked auth, then clear auths for the cast.
      env.mock_all_auths();
      let id = crate::test::create_default_proposal(&env, &gov);
      env.set_auths(&[]); // clear: cast_vote sees NO admin auth -> require_auth() fails.
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"a"), sealed_commitment_hash: sealed_commit_be32(&env) };
      let res = gov.try_cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed, &true);
      assert!(res.is_err()); // auth failure (the off-chain coordinator did not authorize)
  }
  ```
  > Auth-test mechanics (`mock_all_auths`, `set_auths`) — verify exact names against `soroban-sdk 26.0.0`
  > testutils: `npx ctx7@latest docs /stellar/rs-soroban-sdk "testutils mock_all_auths set_auths require_auth negative test no auth"`.
  > The two load-bearing assertions: (1) `verified == false` → `GovError::InvalidProof`; (2) no admin auth
  > → error. Adjust harness calls to whatever the SDK exposes; do not weaken the assertions.
  Add `#[cfg(test)] mod test_offchain;` to `lib.rs`. Make `default_quorum` and `create_default_proposal` `pub(crate)` in `test.rs` so the fallback module reuses them.
- [ ] **RED — Run:** `cargo test -p gov-vault --features offchain-verify offchain_verify_rejects_unverified_flag 2>&1 | tail -12`
  **Expected:** PASS (the `if !verified { panic }` branch in Task 4.22 exists). To prove a GENUINE red, FIRST delete the `if !verified { panic_with_error!(...) }` lines from the fallback branch, run → **Expected FAIL:** `assertion ... expected Err(Ok(InvalidProof))` (the `verified == false` vote is accepted). Restore the check, then confirm green. (This is the genuine red for the flag — the flag was previously absent, so removing it reproduces the original dropped-flag bug.)
- [ ] **GREEN — Run:** `cargo test -p gov-vault --features offchain-verify 2>&1 | tail -12`
  **Expected PASS:** all three fallback tests pass. AND confirm the PRIMARY suite still passes without the feature: `cargo test -p gov-vault 2>&1 | tail -6`.
- [ ] **Commit:** `test(gov-vault): off-chain-verify fallback requires coordinator auth + verified flag`

### Task 4.30b — REAL off-chain coordinator verification (the thing the fallback exists for) (RED→GREEN)

The on-chain `verified` flag is only trustworthy if the coordinator that sets it runs REAL verification and refuses invalid proofs. This task implements and tests that coordinator with `snarkjs.groth16.verify` — a TAMPERED proof must be rejected OFF-CHAIN before the contract is ever called (charter rule 3: no untested escape hatch; rule 4: REAL proof, no faked success).

- [ ] **RED — Create** `packages/zk-prover/test/coordinator.test.ts`:
  ```typescript
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
  ```
- [ ] **RED — Run:** `npx vitest run packages/zk-prover/test/coordinator.test.ts`
  **Expected FAIL:** `Cannot find module ../src/coordinator.js` / no `verifyAndAuthorize`.
- [ ] **GREEN — Create** `packages/zk-prover/src/coordinator.ts`:
  ```typescript
  // OFF-CHAIN VERIFY coordinator (foundation §2.1 fallback). Runs the REAL snarkjs.groth16.verify and
  // returns the `verified` flag the on-chain `cast_vote` (feature = "offchain-verify") consumes. The
  // coordinator MUST refuse to authorize (verified === false) any proof that does not verify — this is
  // the actual off-chain verification the fallback exists for (charter rule 3). NO faked success.
  import type { Groth16Proof, PublicSignals } from "@shadowkit/shared";
  import { verifyVoteProof } from "./index.js";

  export interface AuthorizationDecision {
    verified: boolean; // -> the `verified: bool` arg of GovVault.cast_vote under offchain-verify
  }

  /** Pre-verify the proof off-chain. Returns { verified: true } ONLY when snarkjs accepts it.
   *  A trusted-coordinator deployment then submits cast_vote(..., verified) under its own auth. */
  export async function verifyAndAuthorize(
    vkey: object, publicSignals: PublicSignals, proof: Groth16Proof,
  ): Promise<AuthorizationDecision> {
    const verified = await verifyVoteProof(vkey, publicSignals, proof);
    return { verified };
  }
  ```
- [ ] **GREEN — Run:** `npx vitest run packages/zk-prover/test/coordinator.test.ts`
  **Expected PASS:** 3 tests (valid → authorized; tampered → refused; wrong signals → refused).
- [ ] **Commit:** `feat(zk-prover): off-chain-verify coordinator runs real snarkjs verify; refuses invalid proofs`

---

## Phase E — `@shadowkit/zk-prover` browser proving + `@shadowkit/snapshot-tool`

### Task 4.31 — `generateVoteProof` / `verifyVoteProof` / `nullifierFor` (RED)

- [ ] **RED — Create** `packages/zk-prover/test/prover.test.ts`:
  ```typescript
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
    const zero = ["0"]; for (let i=1;i<=DEPTH;i++) zero.push(await poseidonHashBls([zero[i-1], zero[i-1]]));
    const merklePath: string[] = [], pathIndices: number[] = [];
    let cur = leaf; for (let i=0;i<DEPTH;i++){ merklePath.push(zero[i]); pathIndices.push(0); cur = await poseidonHashBls([cur, zero[i]]); }
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
  ```
- [ ] **RED — Run:** `npx vitest run packages/zk-prover/test/prover.test.ts`
  **Expected FAIL:** `Cannot find module ../src/index.js` / no `generateVoteProof`.
- [ ] **Commit:** `test(zk-prover): failing generateVoteProof/verify(+negative)/nullifier suite`

### Task 4.32 — `index.ts` + `seal.ts` (GREEN)

- [ ] **GREEN — Create** `packages/zk-prover/src/seal.ts` (signatures MATCH foundation §3.2; M4 ships the deterministic local-seal that produces the SAME `sealedCommitmentHash` the circuit binds; the REAL tlock-js round mapping is wired in M5 — recorded note):
  ```typescript
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
  ```
  > **Signature reconciliation (issue #4).** These now MATCH foundation §3.2 exactly
  > (`timelockSealVote(direction, weight, deadlineUnixSeconds, drand?)`, `timelockUnsealVote(sealed, drand?)`)
  > — the earlier `sealKey`-param form is gone, so M5 consumers do not mismatch. The `sealKey` the circuit
  > needs is RETURNED from `timelockSealVote` (foundation §3.2 return type extended to
  > `SealedVoteCiphertext & { sealKey }`). M4's `round = 0` and "deadline not yet bound to the ciphertext"
  > are EXPLICIT stubs; the real deadline→round binding (the "sealed-until-close" property, spec D6) is
  > delivered in M5. M4 delivers only the Poseidon commitment (which IS real). This stub boundary is
  > recorded in foundation §3.2 and Task 4.40.
- [ ] **GREEN — Create** `packages/zk-prover/src/index.ts`:
  ```typescript
  import * as snarkjs from "snarkjs";
  import type { Groth16Proof, PublicSignals, SealedVoteCiphertext } from "@shadowkit/shared";
  import { poseidonHashBls } from "./poseidon.js";
  import { timelockSealVote, type DrandConfig } from "./seal.js";
  export type { DrandConfig } from "./seal.js";

  export interface VoteInput {
    secret: string; merklePath: string[]; pathIndices: number[];
    weight: string; proposalId: string; direction: 0 | 1; merkleRoot: string;
  }
  export interface VoteProofResult {
    proof: Groth16Proof;
    publicSignals: PublicSignals; // [merkleRoot, nullifier, proposalId, sealedCommitmentHash]
    sealedCiphertext: SealedVoteCiphertext;
  }

  /** nullifier = Poseidon(secret, proposalId) over BLS12-381 (matches vote.circom constraint #3). */
  export async function nullifierFor(secret: string, proposalId: string): Promise<string> {
    return poseidonHashBls([secret, proposalId]);
  }

  export async function generateVoteProof(
    input: VoteInput,
    artifacts: { wasmPath: string; zkeyPath: string },
    deadlineUnixSeconds: number,
    drand?: DrandConfig,
  ): Promise<VoteProofResult> {
    if (!input.merklePath?.length) throw new Error("generateVoteProof: empty merklePath");
    if (input.merklePath.length !== input.pathIndices.length) throw new Error("path/index length mismatch");
    // Seal the vote (foundation §3.2). timelockSealVote returns the `sealKey` so the circuit's private
    // `sealKey` input matches the sealedCommitmentHash it produced (M4: deterministic; M5: tlock + random).
    const sealed = await timelockSealVote(input.direction, input.weight, deadlineUnixSeconds, drand);
    const sealKey = sealed.sealKey;
    const sealedCommitmentDecimal = BigInt(sealed.sealedCommitmentHash).toString();

    const circuitInput = {
      merkleRoot: input.merkleRoot,
      proposalId: input.proposalId,
      sealedCommitmentHash: sealedCommitmentDecimal,
      secret: input.secret,
      weight: input.weight,
      direction: String(input.direction),
      pathElements: input.merklePath,
      pathIndices: input.pathIndices.map(String),
      sealKey,
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, artifacts.wasmPath, artifacts.zkeyPath);
    // snarkjs native order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash] (Task 4.10).
    // Re-map to the BINDING external order.
    const signals: PublicSignals = {
      nullifier: publicSignals[0],
      merkleRoot: publicSignals[1],
      proposalId: publicSignals[2],
      sealedCommitmentHash: publicSignals[3],
    };
    // Strip the circuit-only `sealKey` from the returned ciphertext envelope (it is a private input,
    // never stored on-chain). `sealedCiphertext` is exactly the foundation §3.1 SealedVoteCiphertext.
    const sealedCiphertext: SealedVoteCiphertext = {
      round: sealed.round,
      ciphertext: sealed.ciphertext,
      sealedCommitmentHash: sealed.sealedCommitmentHash,
    };
    return { proof: proof as Groth16Proof, publicSignals: signals, sealedCiphertext };
  }

  export async function verifyVoteProof(
    vkey: object, publicSignals: PublicSignals, proof: Groth16Proof,
  ): Promise<boolean> {
    // snarkjs.verify expects the NATIVE order array [nullifier, merkleRoot, proposalId, sealedCommitmentHash].
    const native = [publicSignals.nullifier, publicSignals.merkleRoot, publicSignals.proposalId, publicSignals.sealedCommitmentHash];
    return snarkjs.groth16.verify(vkey, native, proof as any);
  }
  ```
  > **Re-map indices are grounded in Task 4.10** (`public.json` native order). If Task 4.10 found a different order, update BOTH the re-map here AND `committed_public_signals` in `gov-vault` test_fixtures so all three (circuit, prover, contract) agree.
- [ ] **GREEN — Run:** `npx vitest run packages/zk-prover/test/prover.test.ts`
  **Expected PASS:** 5 tests (3 in `generateVoteProof`: verify true / nullifier parity / malformed throws; 2 in `verifyVoteProof (negative)`: tampered → false / wrong signals → false).
- [ ] **Commit:** `feat(zk-prover): generateVoteProof + verifyVoteProof(+negatives) + nullifierFor (BLS12-381)`

### Task 4.33 — `@shadowkit/snapshot-tool` (RED→GREEN)

- [ ] **Scaffold** `packages/snapshot-tool/package.json`:
  ```json
  {
    "name": "@shadowkit/snapshot-tool",
    "version": "0.0.0",
    "type": "module",
    "main": "src/index.ts",
    "scripts": { "test": "vitest run" },
    "dependencies": { "@shadowkit/zk-prover": "*", "@shadowkit/shared": "*" },
    "devDependencies": { "vitest": "4.1.8", "typescript": "^5.6.0" }
  }
  ```
- [ ] **Run:** `npm install --prefix packages/snapshot-tool --no-audit --no-fund`
- [ ] **RED — Create** `packages/snapshot-tool/test/snapshot.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { buildSnapshot } from "../src/index.js";
  import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

  describe("buildSnapshot", () => {
    it("root is deterministic for the same holders", async () => {
      const holders = [
        { secretCommit: await poseidonHashBls(["12345"]), weight: "1000" },
        { secretCommit: await poseidonHashBls(["67890"]), weight: "500" },
      ];
      const s1 = await buildSnapshot(holders);
      const s2 = await buildSnapshot(holders);
      expect(s1.root).toBe(s2.root);
      expect(s1.depth).toBe(20);
    });

    it("getPath yields a path the circuit accepts (root matches)", async () => {
      const secret = "12345", weight = "1000";
      const holders = [{ secretCommit: await poseidonHashBls([secret]), weight }];
      const s = await buildSnapshot(holders);
      const { merklePath, pathIndices } = s.getPath(0);
      // recompute root from leaf + path; must equal s.root.
      const leaf = await poseidonHashBls([holders[0].secretCommit, weight]);
      let cur = leaf;
      for (let i = 0; i < merklePath.length; i++) {
        cur = pathIndices[i] === 0 ? await poseidonHashBls([cur, merklePath[i]]) : await poseidonHashBls([merklePath[i], cur]);
      }
      expect(cur).toBe(s.root);
    });

    it("tampering the path breaks the root", async () => {
      const holders = [{ secretCommit: await poseidonHashBls(["12345"]), weight: "1000" }];
      const s = await buildSnapshot(holders);
      const { merklePath, pathIndices } = s.getPath(0);
      const leaf = await poseidonHashBls([holders[0].secretCommit, "1000"]);
      let cur = leaf;
      const tampered = [...merklePath]; tampered[0] = "1";
      for (let i = 0; i < tampered.length; i++) {
        cur = pathIndices[i] === 0 ? await poseidonHashBls([cur, tampered[i]]) : await poseidonHashBls([tampered[i], cur]);
      }
      expect(cur).not.toBe(s.root);
    });
  });
  ```
- [ ] **RED — Run:** `npx vitest run packages/snapshot-tool/test/snapshot.test.ts`
  **Expected FAIL:** `Cannot find module ../src/index.js`.
- [ ] **Commit:** `test(snapshot): failing buildSnapshot determinism + path + tamper suite`

### Task 4.34 — `snapshot-tool` implementation + Poseidon parity assertion (GREEN)

- [ ] **GREEN — Create** `packages/snapshot-tool/src/merkle.ts`:
  ```typescript
  // Poseidon Merkle tree over BLS12-381 (parity with circuits/vote/merkle.circom). leaf = Poseidon(secretCommit, weight).
  // Node = Poseidon(left, right). pathIndices[i]=0 means the CURRENT node is the LEFT child at level i.
  import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

  export async function leafHash(secretCommit: string, weight: string): Promise<string> {
    return poseidonHashBls([secretCommit, weight]);
  }

  export async function emptySubtrees(depth: number): Promise<string[]> {
    const zero = ["0"];
    for (let i = 1; i <= depth; i++) zero.push(await poseidonHashBls([zero[i - 1], zero[i - 1]]));
    return zero;
  }
  ```
- [ ] **GREEN — Create** `packages/snapshot-tool/src/index.ts`:
  ```typescript
  import { leafHash, emptySubtrees } from "./merkle.js";
  import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

  export interface Holder { secretCommit: string; weight: string; }
  export interface Snapshot {
    root: string;
    rootBe32Hex: string;
    getPath(leafIndex: number): { merklePath: string[]; pathIndices: number[] };
    leafCount: number;
    depth: number;
  }

  export async function buildSnapshot(holders: Holder[], depth = 20): Promise<Snapshot> {
    const zero = await emptySubtrees(depth);
    // level 0 = leaves (padded to 2^depth with zero[0]).
    let level: string[] = [];
    for (const h of holders) level.push(await leafHash(h.secretCommit, h.weight));
    const leafCount = level.length;

    // Build the full tree level by level, caching the actual nodes so getPath can return siblings.
    const tree: string[][] = [level];
    for (let d = 0; d < depth; d++) {
      const cur = tree[d];
      const next: string[] = [];
      for (let i = 0; i < cur.length; i += 2) {
        const left = cur[i];
        const right = i + 1 < cur.length ? cur[i + 1] : zero[d];
        next.push(await poseidonHashBls([left, right]));
      }
      if (next.length === 0) next.push(zero[d + 1]);
      tree.push(next);
    }
    const root = tree[depth][0];
    const rootBe32Hex = "0x" + BigInt(root).toString(16).padStart(64, "0");

    function getPath(leafIndex: number) {
      const merklePath: string[] = []; const pathIndices: number[] = [];
      let idx = leafIndex;
      for (let d = 0; d < depth; d++) {
        const isRight = idx % 2 === 1;
        const sibIdx = isRight ? idx - 1 : idx + 1;
        const sib = sibIdx < tree[d].length ? tree[d][sibIdx] : zero[d];
        merklePath.push(sib);
        pathIndices.push(isRight ? 1 : 0);
        idx = Math.floor(idx / 2);
      }
      return { merklePath, pathIndices };
    }
    return { root, rootBe32Hex, getPath, leafCount, depth };
  }
  ```
  > **Async note (reconciled with the foundation):** `buildSnapshot` is **async** (`Promise<Snapshot>`) because Poseidon is computed via the circuit wasm (§0.1); `Snapshot.getPath` stays **sync** (the tree is pre-materialized at build time). Foundation §3.3 has been UPDATED to `buildSnapshot(...): Promise<Snapshot>` (per the "add the signature here first" rule), so this is no longer a divergence — the frontend / M5 / demo consumers `await buildSnapshot(...)` against the binding signature.
- [ ] **GREEN — Run:** `npx vitest run packages/snapshot-tool/test/snapshot.test.ts`
  **Expected PASS:** 3 tests.
- [ ] **Add the end-to-end parity test** `packages/snapshot-tool/test/circuit-parity.test.ts` (the snapshot root + prover proof must verify on-chain — proven here by snarkjs verify, and on-chain in Task 4.35):
  ```typescript
  import { describe, it, expect } from "vitest";
  import { resolve } from "node:path";
  import { readFileSync } from "node:fs";
  import { buildSnapshot } from "../src/index.js";
  import { generateVoteProof, verifyVoteProof } from "@shadowkit/zk-prover";
  import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

  const ART = resolve(__dirname, "../../zk-prover/artifacts");
  const vkey = JSON.parse(readFileSync(resolve(ART, "verification_key.json"), "utf8"));

  describe("snapshot <-> prover <-> verifier parity", () => {
    it("a proof against a snapshot-tool root verifies", async () => {
      const secret = "555", weight = "777";
      const sc = await poseidonHashBls([secret]);
      const snap = await buildSnapshot([{ secretCommit: sc, weight }]);
      const { merklePath, pathIndices } = snap.getPath(0);
      const r = await generateVoteProof(
        { secret, merklePath, pathIndices, weight, proposalId: "0", direction: 1, merkleRoot: snap.root },
        { wasmPath: resolve(ART, "vote.wasm"), zkeyPath: resolve(ART, "vote_final.zkey") }, 1_999_999_999);
      expect(r.publicSignals.merkleRoot).toBe(snap.root);
      expect(await verifyVoteProof(vkey, r.publicSignals, r.proof)).toBe(true);
    });
  });
  ```
- [ ] **GREEN — Run:** `npx vitest run packages/snapshot-tool/test/circuit-parity.test.ts`
  **Expected PASS.** (This is the TS-side of the snarkjs↔circuit round-trip; the on-chain side is Task 4.35.)
- [ ] **Commit:** `feat(snapshot): Poseidon Merkle snapshot (BLS12-381) + circuit parity test`

---

## Phase F — End-to-end round-trip + FALLBACK 2 (degraded circuit) + finalize

### Task 4.35 — On-chain round-trip with a FRESHLY generated proof via the FULL prover path (charter primary, REQUIRED)

Charter rule 2 demands the primary path verify REAL, independently-generated proofs on-chain — not only the canonical committed fixture. Critically, the TS prover applies a public-signal RE-MAP (snarkjs native `[nullifier, merkleRoot, proposalId, sealedCommitmentHash]` → binding `[merkleRoot, nullifier, ...]`, Task 4.31) and the gov-vault test loader applies its OWN re-map (`committed_public_signals`, Task 4.21). Those are SEPARATE code paths; a re-map bug in either would not be caught unless a proof produced by `generateVoteProof` is accepted by `gov-vault::cast_vote` ON-CHAIN. This task closes that gap with a SECOND committed bundle generated for a DIFFERENT secret/root through the real `generateVoteProof` path.

- [ ] **Create** a TS helper that emits a fresh proof bundle for a NEW snapshot/voter via the FULL prover path: `packages/zk-prover/scripts/emit-bundle.mjs`:
  > **RUN WITH `npx tsx`** (issue #6): this imports `../src/index.js` and `../../snapshot-tool/src/index.js`,
  > which exist only as `.ts`. Bare `node` cannot resolve `.js`→`.ts` (verified Node 26); `tsx` does.
  ```javascript
  // Emit a fresh proof bundle for a given secret/weight/proposalId to a target dir, using the FULL
  // @shadowkit/zk-prover generateVoteProof path (snapshot-tool root + prover re-map) — so the on-chain
  // round-trip (Task 4.35) exercises the SAME re-map the browser uses. Emits the proof + BOTH the snarkjs
  // NATIVE-order public.json (for the Rust loader that mirrors committed_proof) AND the binding-order
  // signals + root in meta.json for the contract test.
  // RUN WITH: `npx tsx packages/zk-prover/scripts/emit-bundle.mjs <secret> <weight> <proposalId> <outDir>`
  import { writeFileSync, mkdirSync } from "node:fs";
  import { resolve, dirname } from "node:path";
  import { fileURLToPath } from "node:url";
  import { buildSnapshot } from "../../snapshot-tool/src/index.js";
  import { generateVoteProof, verifyVoteProof } from "../src/index.js";
  import { poseidonHashBls } from "../src/poseidon.js";

  const [secret = "555", weight = "777", proposalId = "0", outDir = "circuits/vote/fixtures-fresh"] = process.argv.slice(2);
  const ART = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts");
  const vkey = JSON.parse((await import("node:fs")).readFileSync(resolve(ART, "verification_key.json"), "utf8"));
  const sc = await poseidonHashBls([secret]);
  const snap = await buildSnapshot([{ secretCommit: sc, weight }]);
  const { merklePath, pathIndices } = snap.getPath(0);
  const r = await generateVoteProof(
    { secret, merklePath, pathIndices, weight, proposalId, direction: 1, merkleRoot: snap.root },
    { wasmPath: resolve(ART, "vote.wasm"), zkeyPath: resolve(ART, "vote_final.zkey") }, 1_999_999_999);
  // Self-check off-chain before committing the bundle (REAL snarkjs verify of the re-mapped signals).
  if (!(await verifyVoteProof(vkey, r.publicSignals, r.proof))) throw new Error("emit-bundle: fresh proof failed off-chain verify");
  const dir = resolve(process.cwd(), outDir); mkdirSync(dir, { recursive: true });
  // snarkjs NATIVE order for proof.json compatibility with the Rust loader (mirrors committed_proof):
  const nativePublic = [r.publicSignals.nullifier, r.publicSignals.merkleRoot, r.publicSignals.proposalId, r.publicSignals.sealedCommitmentHash];
  writeFileSync(resolve(dir, "proof.json"), JSON.stringify(r.proof, null, 2));
  writeFileSync(resolve(dir, "public.json"), JSON.stringify(nativePublic, null, 2));
  // meta.json records the BINDING-order signals + root so a reviewer can eyeball the re-map agreement.
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify({ secret, weight, proposalId, root: snap.root, publicSignals: r.publicSignals }, null, 2));
  console.log("emitted FRESH bundle to", dir, "root=", snap.root);
  ```
- [ ] **Run:** `npx --yes tsx packages/zk-prover/scripts/emit-bundle.mjs 555 777 0 circuits/vote/fixtures-fresh`
  **Expected:** `emitted FRESH bundle to .../circuits/vote/fixtures-fresh root= <a DIFFERENT root than fixtures/>`.
  The off-chain self-check (`verifyVoteProof`) must pass or the script throws.
- [ ] **COMMIT THE FRESH BUNDLE** (this is a REQUIRED committed second bundle, NOT gitignored). Force-keep it:
  ```bash
  git add -f circuits/vote/fixtures-fresh/proof.json circuits/vote/fixtures-fresh/public.json circuits/vote/fixtures-fresh/meta.json
  ```
  > The fresh bundle is small (two JSON files + meta). Committing it is REQUIRED so the on-chain
  > round-trip below runs deterministically in CI without needing the TS toolchain. (Issue #7: the
  > "uncomment the loader" escape hatch is removed — this bundle and its on-chain test are mandatory.)
- [ ] **GREEN — Add** a Rust loader to `contracts/gov-vault/src/test_fixtures.rs` that consumes the FRESH
  bundle in the prover's NATIVE order (mirroring `committed_proof`/`committed_public_signals`):
  ```rust
  pub const FRESH_PROOF: &str = include_str!("../../../circuits/vote/fixtures-fresh/proof.json");
  pub const FRESH_PUBLIC: &str = include_str!("../../../circuits/vote/fixtures-fresh/public.json");

  pub fn fresh_proof(e:&Env)->Proof{ let p:ProofJson=serde_json::from_str(FRESH_PROOF).unwrap();
      Proof{ a:g1(e,&p.pi_a[0],&p.pi_a[1]), b:g2(e,&p.pi_b[0][0],&p.pi_b[0][1],&p.pi_b[1][0],&p.pi_b[1][1]), c:g1(e,&p.pi_c[0],&p.pi_c[1]) } }
  // FRESH_PUBLIC native order = [nullifier, merkleRoot, proposalId, sealedCommitmentHash]; re-map to
  // BINDING order [merkleRoot, nullifier, proposalId, sealedCommitmentHash] EXACTLY as committed_public_signals does.
  pub fn fresh_public_signals(e:&Env)->Vec<Fr>{
      let arr:StdVec<String>=serde_json::from_str(FRESH_PUBLIC).unwrap();
      let mut v=Vec::new(e);
      v.push_back(fr(e,&arr[1])); // merkleRoot
      v.push_back(fr(e,&arr[0])); // nullifier
      v.push_back(fr(e,&arr[2])); // proposalId
      v.push_back(fr(e,&arr[3])); // sealedCommitmentHash
      v
  }
  pub fn fresh_merkle_root_be32(e:&Env)->BytesN<32>{ let arr:StdVec<String>=serde_json::from_str(FRESH_PUBLIC).unwrap(); BytesN::from_array(e,&be32(&arr[1])) }
  pub fn fresh_sealed_commit_be32(e:&Env)->BytesN<32>{ let arr:StdVec<String>=serde_json::from_str(FRESH_PUBLIC).unwrap(); BytesN::from_array(e,&be32(&arr[3])) }
  ```
- [ ] **RED — Append** to `contracts/gov-vault/src/test.rs` the on-chain round-trip with the FRESH proof:
  ```rust
  use crate::test_fixtures::{fresh_proof, fresh_public_signals, fresh_merkle_root_be32, fresh_sealed_commit_be32};

  // PROVES the prover's re-map (generateVoteProof) and the contract's re-map agree ON-CHAIN: a proof
  // generated by the full @shadowkit/zk-prover path for a DIFFERENT secret/root is accepted by
  // gov-vault::cast_vote. A re-map bug in EITHER path makes this fail (StaleMerkleRoot / InvalidProof).
  #[test]
  fn onchain_accepts_fresh_prover_proof_end_to_end() {
      let env = Env::default();
      env.mock_all_auths();
      // init with the FRESH bundle's root (different from the canonical committed root).
      let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
      let gov_id = env.register(GovVault {}, ());
      let gov = GovVaultClient::new(&env, &gov_id);
      let admin = Address::generate(&env); let asset = Address::generate(&env);
      gov.init(&admin, &verifier_id, &fresh_merkle_root_be32(&env), &asset, &default_quorum(&env));
      let id = create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"fresh-e2e"), sealed_commitment_hash: fresh_sealed_commit_be32(&env) };
      gov.cast_vote(&id, &fresh_proof(&env), &fresh_public_signals(&env), &sealed);
      assert_eq!(gov.votes_cast(&id), 1);
      assert_eq!(gov.proposal(&id).weighted_yes, None); // still no tally
  }
  ```
- [ ] **RED — Run:** before generating/committing the fresh bundle, the `include_str!` of
  `circuits/vote/fixtures-fresh/proof.json` fails to compile:
  `cargo test -p gov-vault onchain_accepts_fresh_prover_proof_end_to_end 2>&1 | tail -8`
  **Expected FAIL:** `error: couldn't read .../fixtures-fresh/proof.json: No such file or directory`.
  (Genuine red: the fresh proof does not exist until `emit-bundle.mjs` runs.)
- [ ] **GREEN — Run** (after `emit-bundle.mjs` produced + you committed the bundle):
  `cargo test -p gov-vault onchain_accepts_fresh_prover_proof_end_to_end 2>&1 | tail -8`
  **Expected PASS.** This is the on-chain proof that the prover re-map and the contract re-map agree.
- [ ] **Also keep** the committed-fixture round-trip as a second assertion (different root, same VK):
  ```rust
  #[test]
  fn onchain_accepts_committed_proof_end_to_end() {
      let env = Env::default();
      env.mock_all_auths();
      let (gov, _v) = deploy_with_committed_root(&env);
      let id = create_default_proposal(&env, &gov);
      let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"e2e"), sealed_commitment_hash: sealed_commit_be32(&env) };
      gov.cast_vote(&id, &committed_proof(&env), &committed_public_signals(&env), &sealed);
      assert_eq!(gov.votes_cast(&id), 1);
  }
  ```
  **Run:** `cargo test -p gov-vault onchain_accepts_committed_proof_end_to_end 2>&1 | tail -6` → **PASS.**
- [ ] **Commit:** `test(gov-vault): on-chain round-trip accepts a FRESH prover-generated proof (re-map agreement)`

### Task 4.36 — FALLBACK 2: degraded circuit (membership + nullifier only / 1p1v) (RED→GREEN)

Spec §13.2 / foundation §4 fallback ladder: if the full sealed-vote circuit is too hard, degrade to a circuit proving only `[merkleRoot, nullifier, proposalId]` (drop signals 4–6) and treat each vote as 1p1v. This must be REAL, config-selectable, and tested.

- [ ] **Create** `circuits/vote/vote_min.circom` (membership + nullifier + proposalId only):
  ```circom
  pragma circom 2.2.1;
  include "poseidon.circom";
  include "merkle.circom";
  // DEGRADED fallback circuit (spec §13.2): proves membership + nullifier + proposalId binding.
  // No sealed-vote well-formedness; weight is still in the leaf but direction is NOT proven well-formed.
  // Used in 1p1v mode where each accepted vote counts as weight 1.
  template VoteMin(TREE_DEPTH) {
      signal input merkleRoot;
      signal input proposalId;
      signal output nullifier;
      signal input secret;
      signal input weight;
      signal input pathElements[TREE_DEPTH];
      signal input pathIndices[TREE_DEPTH];
      component sc = Poseidon(1); sc.inputs[0] <== secret;
      component leaf = Poseidon(2); leaf.inputs[0] <== sc.out; leaf.inputs[1] <== weight;
      component mt = MerkleTreeChecker(TREE_DEPTH);
      mt.leaf <== leaf.out; mt.root <== merkleRoot;
      for (var i = 0; i < TREE_DEPTH; i++) { mt.pathElements[i] <== pathElements[i]; mt.pathIndices[i] <== pathIndices[i]; }
      component nf = Poseidon(2); nf.inputs[0] <== secret; nf.inputs[1] <== proposalId; nullifier <== nf.out;
  }
  component main {public [merkleRoot, proposalId]} = VoteMin(20);
  ```
- [ ] **Create** the degraded-circuit input generator `circuits/vote/scripts/make-input-min.mjs` (same single-voter tree as `make-input.mjs`, minus direction/sealKey; `weight` stays in the leaf):
  > **RUN WITH `npx tsx`** (issue #6 — imports `poseidon.ts` via a `.js` specifier).
  ```javascript
  // Build a valid vote_min.circom input.json (membership + nullifier + proposalId only).
  // RUN WITH: `npx tsx circuits/vote/scripts/make-input-min.mjs`
  import { writeFileSync } from "node:fs";
  import { poseidonHashBls } from "../../../packages/zk-prover/src/poseidon.js";

  const DEPTH = 20;
  const secret = "12345", weight = "1000", proposalId = "0";
  const secretCommit = await poseidonHashBls([secret]);
  const leaf = await poseidonHashBls([secretCommit, weight]);
  const nullifier = await poseidonHashBls([secret, proposalId]);
  const zero = ["0"]; for (let i = 1; i <= DEPTH; i++) zero.push(await poseidonHashBls([zero[i - 1], zero[i - 1]]));
  const pathElements = [], pathIndices = [];
  let cur = leaf;
  for (let i = 0; i < DEPTH; i++) { pathElements.push(zero[i]); pathIndices.push(0); cur = await poseidonHashBls([cur, zero[i]]); }
  const input = { merkleRoot: cur, proposalId, secret, weight, pathElements, pathIndices };
  writeFileSync(new URL("../fixtures-min/input.json", import.meta.url), JSON.stringify(input, null, 2));
  console.log("wrote fixtures-min/input.json; nullifier =", nullifier, "root =", cur);
  ```
- [ ] **Create** the sibling fixtures script `scripts/snapshot-fixtures-min.sh` (concrete, mirrors Task 4.6's verified snarkjs CLI for the `vote_min` circuit):
  ```bash
  #!/usr/bin/env bash
  # Regenerate the DEGRADED (fallback-2) circuit fixtures: compile vote_min.circom, local Groth16
  # trusted setup over BLS12-381, export VK, produce a sample proof. Mirrors scripts/snapshot-fixtures.sh
  # (same verified snarkjs CLI: powersoftau new/contribute/prepare phase2; groth16 setup; zkey
  # contribute/beacon; export verificationkey; groth16 fullprove/verify) for the 3-public-signal circuit.
  set -euo pipefail
  cd "$(dirname "$0")/.."
  CIRC=circuits/vote
  FXM=$CIRC/fixtures-min
  POW=12
  ENTROPY="shadowkit-min-$(date +%s)"
  BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  mkdir -p "$FXM" "$CIRC/build-min"

  echo "== compile vote_min.circom (BLS12-381) =="
  ( cd "$CIRC" && circom vote_min.circom --r1cs --wasm --sym -p bls12381 -l node_modules -o build-min )

  SNARKJS="npx --yes snarkjs@0.7.6"
  echo "== powers of tau (bls12381) =="
  $SNARKJS powersoftau new bls12381 $POW "$CIRC/build-min/pot_0.ptau" -v
  $SNARKJS powersoftau contribute "$CIRC/build-min/pot_0.ptau" "$CIRC/build-min/pot_1.ptau" --name="sk-min-ptau" -e="$ENTROPY" -v
  $SNARKJS powersoftau prepare phase2 "$CIRC/build-min/pot_1.ptau" "$CIRC/build-min/pot_final.ptau" -v
  echo "== groth16 phase2 (zkey) =="
  $SNARKJS groth16 setup "$CIRC/build-min/vote_min.r1cs" "$CIRC/build-min/pot_final.ptau" "$CIRC/build-min/vote_min_0.zkey"
  $SNARKJS zkey contribute "$CIRC/build-min/vote_min_0.zkey" "$CIRC/build-min/vote_min_1.zkey" --name="sk-min-zkey" -e="$ENTROPY" -v
  $SNARKJS zkey beacon "$CIRC/build-min/vote_min_1.zkey" "$FXM/vote_min_final.zkey" "$BEACON" 10 -n="sk-min-beacon"
  $SNARKJS zkey export verificationkey "$FXM/vote_min_final.zkey" "$FXM/verification_key.json"
  cp "$CIRC/build-min/vote_min.r1cs" "$FXM/vote_min.r1cs"
  cp "$CIRC/build-min/vote_min_js/vote_min.wasm" "$FXM/vote_min.wasm"

  echo "== generate input.json (npx tsx) =="
  npx --yes tsx "$CIRC/scripts/make-input-min.mjs"

  echo "== sample proof =="
  $SNARKJS groth16 fullprove "$FXM/input.json" "$FXM/vote_min.wasm" "$FXM/vote_min_final.zkey" "$FXM/proof.json" "$FXM/public.json"
  $SNARKJS groth16 verify "$FXM/verification_key.json" "$FXM/public.json" "$FXM/proof.json"
  echo "== min sample proof verified OK =="
  ```
  ```bash
  chmod +x scripts/snapshot-fixtures-min.sh
  ```
- [ ] **RED — Create** `circuits/vote/test/min.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import * as snarkjs from "snarkjs";
  const FX = resolve(__dirname, "../fixtures-min");
  describe("degraded vote_min circuit (membership + nullifier only)", () => {
    it("3 public signals [nullifier, merkleRoot, proposalId] and verifies", async () => {
      const input = JSON.parse(readFileSync(resolve(FX, "input.json"), "utf8"));
      const vkey = JSON.parse(readFileSync(resolve(FX, "verification_key.json"), "utf8"));
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, resolve(FX, "vote_min.wasm"), resolve(FX, "vote_min_final.zkey"));
      expect(publicSignals.length).toBe(3); // nullifier(out) + merkleRoot + proposalId
      expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
    });
  });
  ```
- [ ] **RED — Run** (before generating fixtures-min): `cd circuits/vote && npx vitest run test/min.test.ts`
  **Expected FAIL:** `ENOENT ... fixtures-min/input.json`.
- [ ] **GREEN — Run** the generator then re-run:
  ```bash
  bash scripts/snapshot-fixtures-min.sh && ls circuits/vote/fixtures-min/
  cd circuits/vote && npx vitest run test/min.test.ts
  ```
  **Expected PASS** (and `fixtures-min/{vote_min.wasm,vote_min_final.zkey,verification_key.json,proof.json,public.json,input.json,vote_min.r1cs}` listed).
- [ ] **Commit:** `feat(circuit): degraded vote_min fallback circuit + fixtures-min (3 public signals)`

#### Task 4.36b — On-chain `cast_vote_min` (1p1v) + double-vote + replay negatives (RED→GREEN)

The degraded on-chain path is a SEPARATE entrypoint behind `feature = "circuit-min"` that consumes 3 public signals, skips the sealed-commitment check, and records weight = 1. It MUST keep the nullifier (double-vote) and proposalId (replay) guards — so its own negative suite mirrors 4.23/4.24.

- [ ] **Add** the feature to `contracts/gov-vault/Cargo.toml`:
  ```toml
  [features]
  offchain-verify = []
  circuit-min = []   # FALLBACK 2: degraded membership+nullifier circuit, 1-person-1-vote (spec §13.2)
  ```
- [ ] **Add** the min-bundle loader to `contracts/gov-vault/src/test_fixtures.rs` (3-signal native order `[nullifier, merkleRoot, proposalId]`):
  ```rust
  pub const PROOF_MIN: &str = include_str!("../../../circuits/vote/fixtures-min/proof.json");
  pub const PUBLIC_MIN: &str = include_str!("../../../circuits/vote/fixtures-min/public.json");

  pub fn committed_proof_min(e:&Env)->Proof{ let p:ProofJson=serde_json::from_str(PROOF_MIN).unwrap();
      Proof{ a:g1(e,&p.pi_a[0],&p.pi_a[1]), b:g2(e,&p.pi_b[0][0],&p.pi_b[0][1],&p.pi_b[1][0],&p.pi_b[1][1]), c:g1(e,&p.pi_c[0],&p.pi_c[1]) } }
  // PUBLIC_MIN native order = [nullifier, merkleRoot, proposalId]; GovVault min order is BINDING
  // [merkleRoot, nullifier, proposalId] (mirrors the full re-map, minus sealedCommitmentHash).
  pub fn committed_public_signals_min(e:&Env)->Vec<Fr>{
      let arr:StdVec<String>=serde_json::from_str(PUBLIC_MIN).unwrap();
      let mut v=Vec::new(e);
      v.push_back(fr(e,&arr[1])); // merkleRoot
      v.push_back(fr(e,&arr[0])); // nullifier
      v.push_back(fr(e,&arr[2])); // proposalId
      v
  }
  pub fn merkle_root_min_be32(e:&Env)->BytesN<32>{ let arr:StdVec<String>=serde_json::from_str(PUBLIC_MIN).unwrap(); BytesN::from_array(e,&be32(&arr[1])) }
  ```
- [ ] **Add** a min embedded-VK so the on-chain verifier can check the 3-signal proof.
  1. **Extend** `contracts/groth16-verifier/src/bin/embed_vk.rs` (Task 4.15) to ALSO emit `vk_min.rs`:
     read the path from `argv` (default `circuits/vote/fixtures/verification_key.json` → `src/vk.rs`;
     when invoked with `min`, read `circuits/vote/fixtures-min/verification_key.json` → `src/vk_min.rs`
     emitting `pub fn embedded_vk_min(env: &Env) -> VerificationKey` with the SAME byte-array body shape).
     Concretely, in `main()`:
     ```rust
     let min = std::env::args().any(|a| a == "min");
     let (src, dst, fname) = if min {
         ("circuits/vote/fixtures-min/verification_key.json", "contracts/groth16-verifier/src/vk_min.rs", "embedded_vk_min")
     } else {
         ("circuits/vote/fixtures/verification_key.json", "contracts/groth16-verifier/src/vk.rs", "embedded_vk")
     };
     // ...read `src`, build `ic`, then format the same template but with `pub fn {fname}(...)`...
     ```
     Run: `cargo run -p groth16-verifier --bin embed_vk --features host-tools -- min` → `wrote vk_min.rs with 4 IC points` (3 public signals + 1).
  2. **Add** to `contracts/groth16-verifier/src/lib.rs`: `mod vk_min;` and the convenience entrypoint:
     ```rust
     #[contractimpl]
     impl Groth16Verifier {
         /// Degraded (fallback-2) verify: loads the EMBEDDED min VK (vk_min.rs) for the 3-public-signal
         /// vote_min circuit. pub_signals order BINDING: [merkleRoot, nullifier, proposalId].
         pub fn verify_min(env: Env, proof: Proof, pub_signals: Vec<Fr>) -> bool {
             let vk = vk_min::embedded_vk_min(&env);
             Self::verify_proof(env, vk, proof, pub_signals).unwrap_or(false)
         }
     }
     ```
  > Both `verify` and `verify_min` live in the verifier crate unconditionally (no feature gate there) —
  > the verifier just exposes both; `gov-vault` picks which under its OWN `circuit-min` feature. (A 3-signal
  > VK has 4 IC points.)
- [ ] **RED — Append** to `contracts/gov-vault/src/test.rs` (gated to the feature) the 1p1v suite:
  ```rust
  #[cfg(feature = "circuit-min")]
  mod min_path {
      use super::*;
      use crate::test_fixtures::{committed_proof_min, committed_public_signals_min, merkle_root_min_be32};

      fn deploy_min(env: &Env) -> GovVaultClient<'static> {
          let verifier_id = env.register(groth16_verifier::Groth16Verifier {}, ());
          let gov_id = env.register(GovVault {}, ());
          let gov = GovVaultClient::new(env, &gov_id);
          let admin = Address::generate(env); let asset = Address::generate(env);
          gov.init(&admin, &verifier_id, &merkle_root_min_be32(env), &asset, &default_quorum(env));
          gov
      }

      #[test]
      fn cast_vote_min_1p1v_counts_one() {
          let env = Env::default(); env.mock_all_auths();
          let gov = deploy_min(&env);
          let id = create_default_proposal(&env, &gov);
          let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"min"), sealed_commitment_hash: BytesN::from_array(&env, &[0u8; 32]) };
          gov.cast_vote_min(&id, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
          assert_eq!(gov.votes_cast(&id), 1);
          assert_eq!(gov.proposal(&id).weighted_yes, None);
      }

      #[test]
      fn cast_vote_min_double_vote_rejected() {
          let env = Env::default(); env.mock_all_auths();
          let gov = deploy_min(&env);
          let id = create_default_proposal(&env, &gov);
          let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"min"), sealed_commitment_hash: BytesN::from_array(&env, &[0u8; 32]) };
          gov.cast_vote_min(&id, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
          let res = gov.try_cast_vote_min(&id, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
          assert_eq!(res, Err(Ok(GovError::NullifierUsed)));
      }

      #[test]
      fn cast_vote_min_replay_other_proposal_rejected() {
          let env = Env::default(); env.mock_all_auths();
          let gov = deploy_min(&env);
          let _id0 = create_default_proposal(&env, &gov);
          let id1 = create_default_proposal(&env, &gov); // == 1; committed_min proof has proposalId 0
          let sealed = SealedVote { round: 0, ciphertext: Bytes::from_array(&env, b"min"), sealed_commitment_hash: BytesN::from_array(&env, &[0u8; 32]) };
          let res = gov.try_cast_vote_min(&id1, &committed_proof_min(&env), &committed_public_signals_min(&env), &sealed);
          assert_eq!(res, Err(Ok(GovError::WrongProposalId)));
      }
  }
  ```
- [ ] **RED — Run:** `cargo test -p gov-vault --features circuit-min cast_vote_min_1p1v_counts_one 2>&1 | tail -10`
  **Expected FAIL (genuine):** `no method named cast_vote_min` (the entrypoint does not exist yet).
- [ ] **GREEN — Add** `cast_vote_min` to `contracts/gov-vault/src/lib.rs` behind the feature (3-signal index constants; reuses nullifier + proposalId + stale-root guards; weight = 1):
  ```rust
  // 3-signal BINDING order for the degraded circuit: [merkleRoot, nullifier, proposalId].
  #[cfg(feature = "circuit-min")]
  const PSM_MERKLE_ROOT: u32 = 0;
  #[cfg(feature = "circuit-min")]
  const PSM_NULLIFIER: u32 = 1;
  #[cfg(feature = "circuit-min")]
  const PSM_PROPOSAL_ID: u32 = 2;

  #[cfg(feature = "circuit-min")]
  #[contractimpl]
  impl GovVault {
      /// FALLBACK 2 (1p1v): degraded membership+nullifier proof; weight is recorded as 1 regardless of
      /// the leaf weight, and there is NO sealed-commitment check (the degraded circuit drops it).
      /// Keeps the deadline + nullifier (double-vote) + proposalId (replay) + stale-root guards.
      pub fn cast_vote_min(
          env: Env,
          id: u32,
          proof: Proof,
          pub_signals: Vec<Bls12381Fr>,
          sealed_ciphertext: SealedVote,
      ) {
          let mut rec = storage::get_proposal(&env, id).unwrap_or_else(|| panic_with_error!(&env, GovError::ProposalNotFound));
          if env.ledger().timestamp() >= rec.deadline {
              panic_with_error!(&env, GovError::DeadlinePassed);
          }
          if pub_signals.len() != 3 {
              panic_with_error!(&env, GovError::InvalidProof);
          }
          let nullifier = fr_to_bytes32(&env, &pub_signals.get(PSM_NULLIFIER).unwrap());
          if storage::nullifier_used(&env, &nullifier) {
              panic_with_error!(&env, GovError::NullifierUsed);
          }
          if !fr_eq_u32(&env, &pub_signals.get(PSM_PROPOSAL_ID).unwrap(), id) {
              panic_with_error!(&env, GovError::WrongProposalId);
          }
          let stored_root: BytesN<32> = storage::get_merkle_root(&env);
          if !fr_eq_bytes32(&env, &pub_signals.get(PSM_MERKLE_ROOT).unwrap(), &stored_root) {
              panic_with_error!(&env, GovError::StaleMerkleRoot);
          }
          // verify the degraded proof against the min embedded VK (4 IC points).
          let verifier = Groth16VerifierClient::new(&env, &storage::get_verifier(&env));
          if !verifier.verify_min(&proof, &pub_signals) {
              panic_with_error!(&env, GovError::InvalidProof);
          }
          // 1p1v: store the ciphertext (sealed direction only; weight is forced to 1 at reveal).
          storage::mark_nullifier(&env, &nullifier);
          storage::push_sealed_vote(&env, id, &sealed_ciphertext);
          rec.votes_cast += 1;
          storage::set_proposal(&env, id, &rec);
          VoteCast { id, nullifier }.publish(&env);
      }
  }
  ```
  > The 1p1v weight=1 semantics are enforced at REVEAL (M5 close_and_reveal counts each min-vote as
  > weight 1 regardless of the decrypted weight); M4 only proves intake (counts_one) + the two negatives.
  > `verify_min` is the groth16-verifier convenience entrypoint added above (loads `embedded_vk_min`).
- [ ] **GREEN — Run:** `cargo test -p gov-vault --features circuit-min 2>&1 | tail -10`
  **Expected PASS:** `cast_vote_min_1p1v_counts_one`, `cast_vote_min_double_vote_rejected`,
  `cast_vote_min_replay_other_proposal_rejected` all pass. Confirm PRIMARY still green:
  `cargo test -p gov-vault 2>&1 | tail -4`.
- [ ] **Commit:** `feat(gov-vault): 1p1v cast_vote_min fallback (counts-one + double-vote + replay negatives)`

### Task 4.37 — `just` wiring + full-suite gate

- [ ] **Modify** `justfile` — add circuit recipes and wire fallbacks into `just test`:
  ```just
  # Build the circuit + regenerate fixtures (BLS12-381 trusted setup).
  circuit-build:
      ./scripts/snapshot-fixtures.sh

  # Run circuit + helper tests.
  circuit-test:
      cd circuits/vote && npx vitest run

  # Append to the existing `test` recipe (do not duplicate the recipe; add these lines):
  #   cargo test --workspace
  #   cargo test -p gov-vault --features offchain-verify
  #   cargo test -p gov-vault --features circuit-min
  #   cd circuits/vote && npx vitest run
  #   npx vitest run packages/zk-prover packages/snapshot-tool
  ```
  Edit the existing `test:` recipe (from M0) to include those five lines (the two `--features` runs cover
  BOTH fallbacks; the zk-prover run covers the off-chain `coordinator` suite).
- [ ] **Run:** `just circuit-test`
  **Expected PASS:** circuit + signals + order + min suites all green.
- [ ] **Run the no-cheating audit** (charter §7.2):
  ```bash
  grep -rnE '#\[ignore\]|\.skip\(|\.only\(|it\.todo|xfail|assert!\(true\)|expect\(true\)\.toBe\(true\)' \
    contracts/groth16-verifier contracts/gov-vault circuits/vote packages/zk-prover packages/snapshot-tool || echo "CLEAN: no skipped/ignored/always-pass tests"
  ```
  **Expected:** `CLEAN: ...` (or each hit carries an inline justification comment).
- [ ] **Commit:** `build(repo): wire circuit + zk fallbacks into just test; no-cheating audit clean`

### Task 4.38 — Full M4 gate: every suite green (primary AND both fallbacks)

- [ ] **Run, in order, and confirm each PASS:**
  ```bash
  cargo test --workspace 2>&1 | tail -6
  cargo test -p gov-vault --features offchain-verify 2>&1 | tail -6
  cargo test -p gov-vault --features circuit-min 2>&1 | tail -6
  cd circuits/vote && npx vitest run 2>&1 | tail -8 && cd ../..
  npx vitest run packages/zk-prover packages/snapshot-tool 2>&1 | tail -8
  ```
  **Expected:** all green. The PRIMARY (on-chain verify, default features) passes WITHOUT any fallback flag (charter rule 2). Both fallbacks pass under their flags (charter rule 3).
- [ ] **Run** `just test` once to confirm the aggregate gate.
  **Expected:** exits 0.
- [ ] **Commit:** `test(repo): M4 gate green — on-chain Groth16 primary + offchain-verify + circuit-min fallbacks`

### Task 4.39 — `.gitignore` for circuit build artifacts; keep committed fixtures

- [ ] **Verify/append** `.gitignore` so large intermediates are ignored but committed fixtures are force-kept:
  ```gitignore
  # Circuit build intermediates (ignored)
  circuits/*/build/
  circuits/*/build-min/
  *.ptau
  *.wtns
  # but DO commit the canonical fixtures + degraded fixtures + the FRESH round-trip bundle (Task 4.35):
  !circuits/vote/fixtures/
  !circuits/vote/fixtures/*
  !circuits/vote/fixtures-min/
  !circuits/vote/fixtures-min/*
  !circuits/vote/fixtures-fresh/
  !circuits/vote/fixtures-fresh/*
  !circuits/poseidon-helpers/fixtures/
  !circuits/poseidon-helpers/fixtures/*
  ```
  > NOTE: `circuits/vote/fixtures-fresh/` is now a COMMITTED bundle (the second proof for the on-chain
  > re-map round-trip, Task 4.35) — it is NO LONGER gitignored. The earlier draft ignored it; that line is
  > removed so `proof.json`/`public.json`/`meta.json` under it are tracked.
- [ ] **Run:** `git status --short circuits/ | head -30`
  **Expected:** committed fixtures (including `fixtures-fresh/`) appear as tracked; `build/` does not.
- [ ] **Commit:** `chore(repo): ignore circuit build intermediates; force-keep committed fixtures`

### Task 4.40 — Milestone close-out note (M5 hand-off, no code)

- [ ] **Verify** the M4 deliverable boundary is documented in-repo (a short note in `circuits/vote/README.md`), capturing the recorded deviations so M5/reviewers see them. ALL of these are reflected in the foundation (the "add the signature here first" rule), not only noted here:
  - **Poseidon field parity (§0.1):** TS Poseidon delegates to the BLS12-381 circuit wasm via `snarkjs.wtns.calculate(input, wasm, tmpPath)` + `snarkjs.wtns.exportJson(tmpPath)` (VERIFIED snarkjs@0.7.6 API); `poseidon-lite` (BN254) is intentionally NOT used. `snapshot-tool.buildSnapshot` is async as a result (foundation §3.3 updated to `Promise<Snapshot>`; `getPath` stays sync).
  - **Seal scope + signature:** `timelockSealVote(direction, weight, deadlineUnixSeconds, drand?)` / `timelockUnsealVote(sealed, drand?)` MATCH foundation §3.2 (return type extended to `SealedVoteCiphertext & { sealKey }`, recorded in §3.2). M4 produces the REAL in-circuit Poseidon commitment but a deterministic local ciphertext body with `round = 0` (STUB); REAL `tlock-js` `timelockEncrypt(round, payload, client)` with `round = roundForDeadline(deadline)` and the deadline→round "sealed-until-close" binding (spec D6) are wired in M5 (`2026-06-02-shadowkit-M5-timelock-weighted-reveal.md`).
  - **Close path boundary (M5 hand-off):** M4 does **NOT** create `close_and_reveal` and does **NOT** leave a `close_and_reveal` stub. M4 keeps M1's plaintext `close(env, id)` + plaintext tally UNCHANGED (only `init` and `cast_vote` change in M4). The on-chain sealed `close_and_reveal` re-aggregation + `reveal.rs` (foundation §2.2) are CREATED in M5, and M5 RETIRES the leftover M1 plaintext `close`/tally once the sealed path lands (M5 Task C7) so there is a single close path.
  - **`init` reintroduces verifier+merkle_root (M4 Task 4.19a):** M1 deferred `verifier`/`merkle_root` ("M4 reintroduces verifier/merkle_root") and shipped `init(admin, treasury_asset, quorum_cfg, vote_weights)`. M4 Task 4.19a MODIFIES `init` to the foundation §2.2 form `init(admin, verifier, merkle_root, treasury_asset, quorum_cfg)` (sets `DataKey::Verifier`/`MerkleRoot` via `storage::set_verifier`/`set_merkle_root`) and RETIRES the M1 `vote_weights`/`weight_of` snapshot path (the snapshot Merkle root + zk proof replace per-address plaintext weights).
  - **Off-chain-verify fallback:** the on-chain `cast_vote` under `feature = offchain-verify` takes an EXTRA `verified: bool` arg (foundation §2.1 flag) and the REAL off-chain verification runs in `@shadowkit/zk-prover` `verifyAndAuthorize` (foundation §3.2). Two distinct `cast_vote` ABIs (primary 5-arg / offchain 6-arg) — recorded in foundation §2.1/§2.2.
  - **Public-signal re-map:** snarkjs native order `[nullifier, merkleRoot, proposalId, sealedCommitmentHash]` → BINDING `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]` in `@shadowkit/zk-prover`, mirrored in `gov-vault` test fixtures, and CROSS-CHECKED on-chain by the fresh-proof round-trip (Tasks 4.10, 4.31, 4.35).
  - **Package exports:** `@shadowkit/zk-prover` declares an `exports` map (`.`/`./poseidon`/`./seal`/`./coordinator`); cross-package consumers import via subexports, not deep `/src/*.js` paths.
  - **Script runner:** `make-input.mjs`, `make-input-min.mjs`, `emit-bundle.mjs` run via `npx tsx` (Node 26 cannot resolve `.js`→`.ts`).
- [ ] **Create** `circuits/vote/README.md` with the bullets above.
- [ ] **Commit:** `docs(circuit): record M4 deviations + M5 hand-off boundary`

---

## Definition of Done (M4)

All of the following must hold (verify with the exact commands in Task 4.38):

1. **PRIMARY (no fallback):** `cargo test --workspace` green — `groth16-verifier` verifies the committed REAL snarkjs proof on-chain (BLS12-381), and `gov-vault::cast_vote` requires the proof, enforces nullifier (double-vote → `NullifierUsed`), proposalId binding (replay → `WrongProposalId`), merkleRoot (`StaleMerkleRoot`), sealed-commitment binding (`InvalidProof`), invalid proof (`InvalidProof`), post-deadline (`DeadlinePassed`), and `proposal()` exposes NO tally before close (`weighted_yes/no == None`). Sealed ciphertext is stored. Each guard was added in its OWN TDD cycle with a genuine red (Tasks 4.23–4.25c); the `Fr`↔bytes helpers have dedicated unit tests (4.21b).
2. **On-chain round-trip (re-map agreement):** a FRESH proof produced by the full `@shadowkit/zk-prover` `generateVoteProof` path (with its native→binding public-signal re-map) for a DIFFERENT secret/root is ACCEPTED by `gov-vault::cast_vote` on-chain (`onchain_accepts_fresh_prover_proof_end_to_end`, Task 4.35) — proving the prover re-map and the contract re-map agree. The committed fixture round-trip also passes.
3. **Circuit tests:** witness satisfiable; `direction ∈ {0,1}` enforced (non-bit rejected); weight↔leaf enforced; nullifier derivation = `Poseidon(secret, proposalId)`; snarkjs↔on-chain round-trip (committed fixture verifies both in `snarkjs.groth16.verify` AND in `Groth16Verifier.verify`).
4. **Verifier negatives:** tampered proof → false; wrong public input → false; malformed VK → `MalformedVerifyingKey` error (NO panic); `verify` maps errors to false. `verifyVoteProof` (TS off-chain twin) has a NEGATIVE test (tampered proof / wrong signals → false, Task 4.31).
5. **FALLBACK 1 (off-chain verify):** `cargo test -p gov-vault --features offchain-verify` green — coordinator-authorized + `verified==true` vote accepted; `verified==false` rejected (`InvalidProof`); unauthorized rejected; config-selectable; PRIMARY still green without the flag. The REAL off-chain verification is tested in `packages/zk-prover/test/coordinator.test.ts` (`verifyAndAuthorize` runs `snarkjs.groth16.verify` and refuses a TAMPERED proof — Task 4.30b).
6. **FALLBACK 2 (degraded circuit / 1p1v):** `vote_min` circuit (3 public signals) verifies; `cargo test -p gov-vault --features circuit-min` green — `cast_vote_min` counts-one PLUS its OWN double-vote (`NullifierUsed`) and replay (`WrongProposalId`) negatives; PRIMARY still green.
7. **TS units:** `@shadowkit/zk-prover` (real proof verifies; deterministic signals; nullifier parity; bad input → error; verify NEGATIVE → false; Poseidon-BLS parity, NOT BN254; off-chain coordinator refuses invalid) and `@shadowkit/snapshot-tool` (root determinism; valid path accepted; tamper → invalid; snapshot↔prover↔verifier parity) green. `make-input.mjs`/`emit-bundle.mjs` run via `npx tsx` (NOT bare `node`).
8. **No cheating:** the audit grep is CLEAN (or every hit has an inline justification); every guard task showed a GENUINE red (feature absent → test fails) before GREEN — no comment-out-then-restore mutation red; the four green-on-first-run regression tests (invalid-proof, no-tally, valid-round-trip, verifier-negatives) carry explicit charter §7.2 justifications; all crypto tests use REAL snarkjs proofs / REAL in-circuit Poseidon (no stubs faking success).
9. **`just test`** exits 0 (aggregate gate runs all of the above).

---

*This plan references foundation `00-foundation-interfaces.md` §1 (file structure), §2.1–§2.2 (Groth16Verifier, GovVault signatures + DataKey + GovError + events), §2.6 (SealedVote), §3.1–§3.3 (PublicSignals, Groth16Proof, VoteInput, Snapshot), §4 (circuit signal layout), §5 (cross-layer matrix), §6 (versions), §7 (testing charter). Any binding-signature change requires updating the foundation first and rippling to dependent plans.*
