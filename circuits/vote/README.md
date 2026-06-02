# `circuits/vote` — ShadowKit ZK sealed-voting circuit (M4 deliverable boundary)

This directory holds the BLS12-381 Groth16 circuit for sealed, privacy-preserving voting plus its
committed fixtures. This README records the M4 deliverable boundary and the recorded deviations so M5
and reviewers can see them at a glance. ALL of these are also reflected in the foundation interfaces
(`docs/superpowers/plans/00-foundation-interfaces.md`) per the "add the signature here first" rule — this
note is a convenience pointer, not the source of truth.

## Circuits

- `vote.circom` — PRIMARY circuit. 4 public signals (binding order)
  `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]`. Proves Merkle membership, nullifier
  derivation, `direction ∈ {0,1}`, weight↔leaf binding, and sealed-vote well-formedness
  (`sealedCommitmentHash = Poseidon(direction, weight, sealKey)`). Fixtures in `fixtures/`; the FRESH
  round-trip bundle (Task 4.35) in `fixtures-fresh/`.
- `vote_min.circom` — DEGRADED FALLBACK 2 (spec §13.2). 3 public signals (binding order)
  `[merkleRoot, nullifier, proposalId]`; drops the sealed-vote well-formedness. Used in 1-person-1-vote
  mode (`gov-vault` `feature = "circuit-min"`, `cast_vote_min`, weight = 1). Fixtures in `fixtures-min/`.

Regenerate with `scripts/snapshot-fixtures.sh` (primary) / `scripts/snapshot-fixtures-min.sh` (degraded).
`build/` and `build-min/` are gitignored intermediates; the `fixtures*/` bundles are committed.

## Recorded M4 deviations / M5 hand-off boundary

- **Poseidon field parity (§0.1):** the TS Poseidon delegates to the BLS12-381 circuit wasm via
  `snarkjs.wtns.calculate(input, wasm, tmpPath)` + `snarkjs.wtns.exportJson(tmpPath)` (verified
  snarkjs@0.7.6 API); `poseidon-lite` (BN254) is intentionally NOT used. `snapshot-tool.buildSnapshot`
  is async as a result (foundation §3.3 updated to `Promise<Snapshot>`; `getPath` stays sync).
- **Seal scope + signature:** `timelockSealVote(direction, weight, deadlineUnixSeconds, drand?)` /
  `timelockUnsealVote(sealed, drand?)` match foundation §3.2 (return type extended to
  `SealedVoteCiphertext & { sealKey }`, recorded in §3.2). M4 produces the REAL in-circuit Poseidon
  commitment but a deterministic local ciphertext body with `round = 0` (STUB); REAL `tlock-js`
  `timelockEncrypt(round, payload, client)` with `round = roundForDeadline(deadline)` and the
  deadline→round "sealed-until-close" binding (spec D6) are wired in M5
  (`2026-06-02-shadowkit-M5-timelock-weighted-reveal.md`).
- **Close path boundary (M5 hand-off):** M4 does NOT create `close_and_reveal` and does NOT leave a
  `close_and_reveal` stub. M4 keeps M1's plaintext `close(env, id)` + plaintext tally UNCHANGED (only
  `init` and `cast_vote` change in M4). The on-chain sealed `close_and_reveal` re-aggregation +
  `reveal.rs` (foundation §2.2) are CREATED in M5, and M5 RETIRES the leftover M1 plaintext `close`/tally
  once the sealed path lands (M5 Task C7) so there is a single close path.
- **`init` reintroduces verifier + merkle_root (M4 Task 4.19a):** M1 deferred `verifier`/`merkle_root`
  ("M4 reintroduces verifier/merkle_root") and shipped `init(admin, treasury_asset, quorum_cfg,
  vote_weights)`. M4 Task 4.19a MODIFIES `init` to the foundation §2.2 form `init(admin, verifier,
  merkle_root, treasury_asset, quorum_cfg)` (sets `DataKey::Verifier`/`MerkleRoot` via
  `storage::set_verifier`/`set_merkle_root`) and RETIRES the M1 `vote_weights`/`weight_of` snapshot path
  (the snapshot Merkle root + zk proof replace per-address plaintext weights).
- **Off-chain-verify fallback:** the on-chain `cast_vote` under `feature = offchain-verify` takes an
  EXTRA `verified: bool` arg (foundation §2.1 flag) and the REAL off-chain verification runs in
  `@shadowkit/zk-prover` `verifyAndAuthorize` (foundation §3.2). Two distinct `cast_vote` ABIs (primary
  5-arg / offchain 6-arg) — recorded in foundation §2.1/§2.2. (The primary `test.rs` suite is gated to
  builds WITHOUT `offchain-verify`; the fallback ABI is covered by `test_offchain.rs`.)
- **Degraded-circuit fallback (FALLBACK 2):** the on-chain `cast_vote_min` (under
  `feature = circuit-min`) consumes the 3-signal `vote_min` proof (BINDING `[merkleRoot, nullifier,
  proposalId]`), skips the sealed-commitment check, records weight = 1 (1p1v enforced at reveal in M5),
  and keeps the nullifier (double-vote) + proposalId (replay) + stale-root guards. `groth16-verifier`
  exposes `verify_min` (embedded `vk_min`, 4 IC points) unconditionally; `gov-vault` selects it under
  its own feature.
- **Public-signal re-map:** snarkjs native order `[nullifier, merkleRoot, proposalId,
  sealedCommitmentHash]` → BINDING `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]` in
  `@shadowkit/zk-prover`, mirrored in `gov-vault` test fixtures, and CROSS-CHECKED on-chain by the
  fresh-proof round-trip (Tasks 4.10, 4.31, 4.35). The degraded circuit mirrors the same re-map minus
  `sealedCommitmentHash`.
- **Package exports:** `@shadowkit/zk-prover` declares an `exports` map (`.`/`./poseidon`/`./seal`/
  `./coordinator`); cross-package consumers import via subexports, not deep `/src/*.js` paths.
- **Script runner:** `make-input.mjs`, `make-input-min.mjs`, `emit-bundle.mjs` run via `npx tsx`
  (Node 26 cannot resolve `.js`→`.ts`).
