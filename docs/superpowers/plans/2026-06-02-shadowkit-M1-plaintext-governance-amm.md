# M1 — Plaintext Governance + FallbackAMM + FE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (- [ ]) syntax.

**Goal:** Ship the ShadowKit M1 milestone — a fully working, on-chain, **plaintext** governance loop (vote → quorum → approved → single-shot execute-mark) plus a constant-product **FallbackAMM** behind a venue-agnostic `SwapVenue` trait, plus the AgentBoard front-end pieces (ProposalList, plaintext VoteModal, tally view). At the end of M1 a user can: create a proposal, have voters vote plaintext (with on-chain auth), reach the deadline, close the proposal so the chain computes the weighted tally and sets `Approved`/`Rejected`, and (separately) execute real swaps against FallbackAMM with slippage protection. **No ZK, no timelock yet** — those arrive in M4/M5 and replace the plaintext `cast_vote` with the sealed signature in foundation §2.2.

**Architecture:** Three Soroban contracts (`gov-vault`, `fallback-amm`, `swap-venue` trait crate) sharing types from `shadowkit-shared`; a React/Astro front-end consuming `@shadowkit/shared` types. The plaintext `cast_vote(env, id, voter, direction)` is the M1 default entrypoint (`require_auth` on `voter`, voter-keyed double-vote guard, per-voter weight read from a snapshot map). `close(id)` computes the plaintext weighted tally on-chain and applies the `QuorumCfg` rule. `FallbackAMM` is itself the swap-venue fallback and is the ONLY venue tested in M1; the `SwapVenue` trait is proven venue-agnostic by registering `FallbackAMM` against the generated `SwapVenueClient` and asserting identical behavior.

**Tech Stack:** Rust 1.94.1 + `soroban-sdk 26.0.0` (target `wasm32v1-none`); Soroban test `Env` for unit + cross-contract integration; SAC test tokens via `register_stellar_asset_contract_v2`. Front-end: Astro 6.4.2 + `@astrojs/react` 5.0.6 + React 19; Vitest 4.1.8 (jsdom) + `@testing-library/react` + `@testing-library/user-event` for component tests. TS types from `@shadowkit/shared` (foundation §3.1). All commits Conventional Commits (foundation §8).

---

## How to use this plan (read before Task 0)

- **Binding source of truth:** `docs/superpowers/plans/00-foundation-interfaces.md` (cited as "foundation §N"). Every type, path, crate name, error code, event, and storage key below is copied from it. The spec is `docs/superpowers/specs/2026-06-02-shadowkit-design.md`.
- **Prerequisite:** M0 (plan `01-m0-scaffold.md`) is DONE — i.e. the Cargo workspace, npm workspace, `justfile`, `rust-toolchain.toml` (Rust 1.94.1, target `wasm32v1-none`), `contracts/shared` crate skeleton, `packages/shared` skeleton, `web/` Astro skeleton, and a green `just test` exist. **Task 0 below verifies this; if it fails, stop and run M0 first.**
- **M1 deviation from foundation §2.2 (recorded, intentional):** foundation §2.2 defines the *final* `cast_vote(env, id, proof, pub_signals, sealed_ciphertext)` and `close_and_reveal(...)`. M1 is the spec's "M1 GovVault **plaintext** voting" row (§11). M1 therefore ships a **plaintext** `cast_vote(env, id, voter, direction)` (auth on `voter`) and a plaintext `close(env, id)` as the DEFAULT build. The sealed signatures are added in M4/M5 and *replace* these. Every OTHER binding item (`ActionSpec`, `ProposalView`, `ProposalStatus`, `QuorumCfg`, `GovError` enum + discriminants, `DataKey`, events, `FallbackAMM`, `AmmError`, `SwapVenue`, `@shadowkit/shared` TS types) is used EXACTLY as the foundation defines it. The plaintext entrypoints are additive; they do not change any binding type.
- **TDD discipline (mandatory, foundation §7):** every implementation task is split into RED (write failing test + run it + paste the real FAIL output) and GREEN (minimal code + run + paste PASS output) then COMMIT. A task that goes green on first run without a prior red is invalid.
- **No cheating (foundation §7):** no `#[ignore]`, `.skip`, `.only`, `it.todo`, `assert!(true)`; real on-chain state assertions; real auth where auth is the thing under test. The grep gate in Task 24 enforces this.
- **Commits:** Conventional Commits, scopes `gov-vault | amm | swap-venue | shared | web | repo`. Footer on every commit body:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Branch:** create `m1-govvault-plaintext` before Task 1 (Task 0.7). Never commit to the default branch.

---

## File Structure (every file created/modified in M1)

Paths and one-line responsibilities match foundation §1 exactly. `[NEW]` = created in M1; `[MOD]` = modified (skeleton exists from M0); `[USE]` = read-only dependency.

| Path | M1 action | Responsibility (foundation §) |
|---|---|---|
| `contracts/shared/src/lib.rs` | `[MOD]` | Add `SwapKind`, `ActionSpec`, `ProposalStatus`, `QuorumCfg`, `ProposalView` (foundation §2.6). M1 does NOT need `SealedVote`/`VoteDecryption` (M4/M5) but adds them as-defined to avoid a later breaking change. |
| `contracts/shared/Cargo.toml` | `[USE]` | `no_std` lib crate `shadowkit-shared`, dep `soroban-sdk 26.0.0` (foundation §1, §6). |
| `contracts/gov-vault/Cargo.toml` | `[NEW]` | crate `gov-vault`, `crate-type=["cdylib","rlib"]`, deps `soroban-sdk`, `shadowkit-shared` (foundation §1). |
| `contracts/gov-vault/src/lib.rs` | `[NEW]` | `#[contract] GovVault`; plaintext entrypoints + `GovError` (foundation §2.2). |
| `contracts/gov-vault/src/storage.rs` | `[NEW]` | `DataKey` enum + typed helpers (foundation §2.2). |
| `contracts/gov-vault/src/test.rs` | `[NEW]` | unit + negative + quorum + integration tests (foundation §7). |
| `contracts/swap-venue/Cargo.toml` | `[NEW]` | crate `swap-venue`, lib, dep `soroban-sdk` (foundation §1). |
| `contracts/swap-venue/src/lib.rs` | `[NEW]` | `#[contractclient(name="SwapVenueClient")] trait SwapVenue` (foundation §2.4). |
| `contracts/fallback-amm/Cargo.toml` | `[NEW]` | crate `fallback-amm`, `crate-type=["cdylib","rlib"]`, deps `soroban-sdk`, `swap-venue` (foundation §1). |
| `contracts/fallback-amm/src/lib.rs` | `[NEW]` | `#[contract] FallbackAMM`; `init/add_liquidity/swap/reserves` + `AmmError` (foundation §2.5). |
| `contracts/fallback-amm/src/test.rs` | `[NEW]` | AMM unit + slippage + SwapVenueClient venue-agnostic tests (foundation §7). |
| `Cargo.toml` (workspace root) | `[MOD]` | add `contracts/gov-vault`, `contracts/swap-venue`, `contracts/fallback-amm` to `[workspace] members`. |
| `packages/shared/src/types.ts` | `[MOD]` | `ProposalStatus`, `ActionSpec`, `ProposalView` TS types (foundation §3.1). |
| `packages/shared/src/index.ts` | `[MOD]` | re-export the types. |
| `web/src/components/ProposalList.tsx` | `[NEW]` | render `ProposalView[]` (foundation §1, §3.7 `ProposalListProps`). |
| `web/src/components/VoteModal.tsx` | `[NEW]` | M1 **plaintext, presentational-only** vote modal: pick Yes/No → call `onCast` callback (foundation §1; M1 plaintext prop variant + presentational-only scope documented in Task 21). On-chain `cast_vote` wiring (`web/src/lib/contracts.ts`) is deferred to a later milestone. |
| `web/src/components/TallyView.tsx` | `[NEW]` | post-close weighted tally view (M1 name for the M1 tally; foundation `RevealedResult` is the M5 sealed-reveal equivalent). |
| `web/src/components/ProposalList.test.tsx` | `[NEW]` | component test. |
| `web/src/components/VoteModal.test.tsx` | `[NEW]` | component test. |
| `web/src/components/TallyView.test.tsx` | `[NEW]` | component test. |
| `web/vitest.config.ts` | `[MOD]` | jsdom env + setup file (Task 17). |
| `web/vitest.setup.ts` | `[NEW]` | `@testing-library/jest-dom` matchers (Task 17). |
| `web/package.json` | `[MOD]` | add test deps (Task 17). |
| `justfile` | `[MOD]` | ensure `just test` runs `cargo test --workspace` + web vitest (Task 23). |

> **VoteModal/TallyView naming note (recorded):** foundation §1 lists `VoteModal.tsx` (kept) and `RevealedResult.tsx` (M5 sealed reveal). M1 has no sealed reveal, so M1's post-close display is named `TallyView.tsx`. When M5 lands, `RevealedResult.tsx` is added per foundation §3.7 `RevealedResultProps`; `TallyView.tsx` is either renamed or kept as the plaintext-demo view. This is a deliberate, traceable divergence: M1 ships a plaintext tally, not a sealed reveal.

---

## Phase 0 — Preconditions & branch

### Task 0 — Verify M0 scaffold is present and green

**Files:** none (read-only verification).

- [ ] 0.1 Confirm you are at the repo root and the workspace skeleton exists:
  ```bash
  cd /home/batuhan4/github/shadowKit && ls Cargo.toml package.json justfile rust-toolchain.toml contracts/shared/src/lib.rs packages/shared/src/types.ts web/package.json
  ```
  **Expected:** all paths print (no `No such file`). If any is missing, STOP — run plan `01-m0-scaffold.md` first.
- [ ] 0.2 Confirm the Rust toolchain + wasm target:
  ```bash
  cargo --version && rustc --version && rustup target list --installed | grep wasm32v1-none
  ```
  **Expected:** `cargo 1.94.1 ...`, `rustc 1.94.1 ...`, and `wasm32v1-none`.
- [ ] 0.3 Confirm the shared crate name + soroban-sdk version pin:
  ```bash
  grep -n 'name = "shadowkit-shared"' contracts/shared/Cargo.toml && grep -rn 'soroban-sdk' Cargo.toml contracts/shared/Cargo.toml
  ```
  **Expected:** crate name line present; `soroban-sdk` pinned to `26.0.0` (foundation §6). If it shows `25.1.0`, update the workspace dep to `26.0.0` (foundation §6 says standardize the whole workspace on 26.0.0) and re-run M0's `cargo test --workspace`.
- [ ] 0.4 Confirm baseline `cargo test` is green:
  ```bash
  cargo test --workspace 2>&1 | tail -15
  ```
  **Expected:** `test result: ok.` lines, exit 0. (M0 ships at least a trivial passing test.)
- [ ] 0.5 Confirm Node/npm + web workspace:
  ```bash
  node --version && npm --version && grep -n '"workspaces"' package.json
  ```
  **Expected:** `v26.0.0`, an npm version, and a `"workspaces"` array including `"web"` and `"packages/*"`.
- [ ] 0.6 **Discover the M0 TypeScript test harness** (this plan must wire into whatever M0 established, not assume it). Inspect:
  ```bash
  cd /home/batuhan4/github/shadowKit && \
    echo "--- root vitest config(s):" && ls -1 vitest.config.* vitest.workspace.* 2>/dev/null || echo "(none at root)"; \
    echo "--- packages/shared config + test script:" && ls -1 packages/shared/vitest.config.* 2>/dev/null || echo "(no packages/shared vitest config)"; \
    grep -n '"test"' packages/shared/package.json 2>/dev/null || echo "(no test script in packages/shared/package.json)"; \
    echo "--- web config + test script:" && ls -1 web/vitest.config.* 2>/dev/null || echo "(no web vitest config yet — created in Task 19)"; \
    grep -n '"test"' web/package.json 2>/dev/null || echo "(no test script in web/package.json yet)"; \
    echo "--- justfile test recipe:" && grep -nA6 '^test:' justfile 2>/dev/null || echo "(no test recipe)"
  ```
  **Record the answers — they drive Tasks 18, 19, 23.** Specifically note:
  - **(a)** Whether a root `vitest.workspace.ts` exists (foundation §1 lists one). If it does, the canonical TS run is `npx vitest run` from the repo root (it aggregates every package's config). If it does NOT, each package is run by pointing vitest at that package's own config.
  - **(b)** Whether `packages/shared` already has its own `vitest.config.ts` and a `"test"` script. If NOT, **Task 18 (step 18.0) creates a node-environment `packages/shared/vitest.config.ts`** so the shared TS tests run with `environment: "node"` (NOT web's jsdom config — `packages/shared` is framework-free).
  - **(c)** The exact M0 `just test` recipe, so Task 23 EXTENDS it rather than guessing.
  > **If M0 created NO TS test harness at all** (no root workspace config, no per-package config, no `test` scripts): this plan still works — Task 18.0 creates `packages/shared/vitest.config.ts`, Task 19 creates `web/vitest.config.ts`, and Task 23 wires a concrete two-command recipe (`cargo test --workspace` + per-package `npx vitest run`). Do NOT rely on an unverified root invocation.
- [ ] 0.7 Create the M1 feature branch:
  ```bash
  cd /home/batuhan4/github/shadowKit && git checkout -b m1-govvault-plaintext && git branch --show-current
  ```
  **Expected:** prints `m1-govvault-plaintext`.

---

## Phase 1 — `shadowkit-shared` types (foundation §2.6)

### Task 1 — Add shared governance types to the Rust shared crate

**Files:** Modify `contracts/shared/src/lib.rs` (append the type definitions). Test path: `contracts/shared/src/lib.rs` (inline `#[cfg(test)] mod tests`).

- [ ] 1.1 **RED.** Add a compile-asserting test at the END of `contracts/shared/src/lib.rs`. This test constructs each type, so it fails to compile until the types exist:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use soroban_sdk::{Env, Address, testutils::Address as _};

      #[test]
      fn shared_types_construct() {
          let env = Env::default();
          let a = Address::generate(&env);
          let b = Address::generate(&env);
          let spec = ActionSpec {
              kind: SwapKind::Swap,
              asset_in: a.clone(),
              asset_out: b.clone(),
              amount: 100_i128,
              min_out: 90_i128,
          };
          let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
          let view = ProposalView {
              id: 0,
              action_spec: spec.clone(),
              cap: 1_000_i128,
              deadline: 1_700_000_000_u64,
              votes_cast: 0,
              status: ProposalStatus::Open,
              weighted_yes: None,
              weighted_no: None,
          };
          assert_eq!(view.status, ProposalStatus::Open);
          assert_eq!(cfg.min_voters, 3);
          assert_eq!(spec.amount, 100);
      }
  }
  ```
- [ ] 1.2 Run it and confirm the RED failure:
  ```bash
  cargo test -p shadowkit-shared shared_types_construct 2>&1 | tail -20
  ```
  **Expected (RED):** compile error `cannot find type 'ActionSpec' in this scope` (and/or `SwapKind`, `QuorumCfg`, `ProposalView`, `ProposalStatus`). Build fails.
- [ ] 1.3 **GREEN.** At the top of `contracts/shared/src/lib.rs` (after the existing `#![no_std]` and any existing `use`), add the BINDING types from foundation §2.6 verbatim. Ensure the file begins exactly:
  ```rust
  #![no_std]
  use soroban_sdk::{contracttype, Address, Bytes, BytesN, Vec};

  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub enum SwapKind { Swap } // only `swap` in scope (spec §14 YAGNI)

  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub struct ActionSpec {
      pub kind: SwapKind,
      pub asset_in: Address,
      pub asset_out: Address,
      pub amount: i128,        // bounded by proposal cap
      pub min_out: i128,       // slippage floor (spec's min_out_policy, materialized)
  }

  #[contracttype]
  #[derive(Clone, Debug, PartialEq, Eq)]
  pub enum ProposalStatus { Open, Tallying, Approved, Rejected, Executed }

  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub struct QuorumCfg {
      pub min_voters: u32,         // default 3
      pub yes_must_exceed_no: bool // default true
  }

  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub struct ProposalView {
      pub id: u32,
      pub action_spec: ActionSpec,
      pub cap: i128,
      pub deadline: u64,
      pub votes_cast: u32,
      pub status: ProposalStatus,
      pub weighted_yes: Option<i128>, // None until close
      pub weighted_no:  Option<i128>, // None until close
  }

  // ---- M4/M5 sealed-vote types (added now to avoid a later breaking change; NOT used by M1) ----
  /// Opaque tlock ciphertext envelope (foundation §2.6). Unused in M1.
  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub struct SealedVote {
      pub round: u64,
      pub ciphertext: Bytes,
      pub sealed_commitment_hash: BytesN<32>,
  }

  /// A single revealed (tlock-decrypted) vote (foundation §2.6). Unused in M1.
  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub struct VoteDecryption {
      pub direction: u32,
      pub weight: i128,
      pub sealed_commitment_hash: BytesN<32>,
  }
  ```
  > Note: `Bytes`, `BytesN`, `Vec` are imported only for the M4/M5 types; keep them so the `use` line above compiles without `unused import` warnings being errors. If your M0 `lib.rs` already declared a different `use soroban_sdk::...`, merge — do not duplicate.
- [ ] 1.4 Run again and confirm GREEN:
  ```bash
  cargo test -p shadowkit-shared shared_types_construct 2>&1 | tail -10
  ```
  **Expected (GREEN):** `test tests::shared_types_construct ... ok` and `test result: ok. 1 passed`.
- [ ] 1.5 **COMMIT:**
  ```bash
  git add contracts/shared/src/lib.rs && git commit -m "$(printf 'feat(shared): add ActionSpec, ProposalView, QuorumCfg, ProposalStatus types\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 2 — `gov-vault` crate scaffold + storage

### Task 2 — Create the `gov-vault` crate and wire it into the workspace

**Files:** Create `contracts/gov-vault/Cargo.toml`, `contracts/gov-vault/src/lib.rs`, `contracts/gov-vault/src/storage.rs`. Modify root `Cargo.toml`.

- [ ] 2.1 Create `contracts/gov-vault/Cargo.toml`:
  ```toml
  [package]
  name = "gov-vault"
  version = "0.1.0"
  edition = "2021"
  publish = false

  [lib]
  crate-type = ["cdylib", "rlib"]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }
  shadowkit-shared = { path = "../shared" }

  [dev-dependencies]
  soroban-sdk = { workspace = true, features = ["testutils"] }
  ```
  > `soroban-sdk = { workspace = true }` requires the root `Cargo.toml` to declare `[workspace.dependencies] soroban-sdk = { version = "26.0.0" }` (M0 did this; if not, add it). The `testutils` feature in dev-deps enables `Env::default`, `Address::generate`, `Ledger`, `register_stellar_asset_contract_v2` (verified ctx7 `/stellar/rs-soroban-sdk` 2026-06-02).
- [ ] 2.2 Create a minimal `contracts/gov-vault/src/storage.rs` with the BINDING `DataKey` (foundation §2.2) — note `DataKey::Verifier`, `MerkleRoot`, `Nullifier` exist in the binding enum for M4/M5; M1 adds a plaintext-vote key `VoterVoted` and a `VoteWeights` snapshot key (additive, recorded):
  ```rust
  use soroban_sdk::{contracttype, Address, BytesN, Map};

  /// Storage keys. Binding subset (foundation §2.2): Admin, Verifier, MerkleRoot, TreasuryAsset,
  /// QuorumCfg, Executor, NextId, Proposal(u32), SealedVotes(u32), Nullifier(BytesN<32>).
  /// M1-additive plaintext keys (recorded divergence — see plan header): VoteWeights, VoterVoted,
  /// YesWeight, NoWeight. These are M1's plaintext mechanism; M4/M5 replace VoterVoted/YesWeight/NoWeight
  /// with the SealedVotes + Nullifier flow. Verifier/MerkleRoot are unused in M1 but kept in the enum
  /// so the binding discriminant order never changes. `Executor` (foundation §2.2) is the authorized
  /// `mark_executed` caller (the AgentPolicy address); it is kept in the enum here (discriminant order)
  /// and POPULATED in M2 via `set_executor` (M1 ships `mark_executed` without the auth gate; M2 tightens it).
  #[contracttype]
  #[derive(Clone)]
  pub enum DataKey {
      Admin,                  // Address (instance)
      Verifier,              // Address (instance) — M4
      MerkleRoot,            // BytesN<32> (instance) — M4
      TreasuryAsset,         // Address (instance)
      QuorumCfg,             // QuorumCfg (instance)
      Executor,              // Address (instance) — AgentPolicy id; set via set_executor in M2; auth for mark_executed
      NextId,                // u32 (instance)
      Proposal(u32),         // ProposalRecord (persistent)
      SealedVotes(u32),      // Vec<SealedVote> (persistent) — M5
      Nullifier(BytesN<32>), // () (persistent) — M4
      // ---- M1-additive plaintext keys ----
      VoteWeights,           // Map<Address,i128> snapshot of eligible voter weights (instance)
      VoterVoted(u32, Address), // () presence = this voter voted on proposal id (persistent)
      YesWeight(u32),        // i128 running plaintext yes weight (persistent)
      NoWeight(u32),         // i128 running plaintext no weight (persistent)
  }

  /// Internal persistent record projected into ProposalView by `proposal()`.
  #[contracttype]
  #[derive(Clone)]
  pub struct ProposalRecord {
      pub action_spec: shadowkit_shared::ActionSpec,
      pub cap: i128,
      pub deadline: u64,
      pub status: shadowkit_shared::ProposalStatus,
      pub weighted_yes: Option<i128>,
      pub weighted_no: Option<i128>,
      pub votes_cast: u32,
      pub executed: bool,
  }
  ```
- [ ] 2.3 Create a minimal `contracts/gov-vault/src/lib.rs` that compiles (entrypoints added in later tasks):
  ```rust
  #![no_std]
  mod storage;
  #[cfg(test)]
  mod test;

  use soroban_sdk::{contract, contracterror};

  #[contract]
  pub struct GovVault;

  #[contracterror]
  #[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
  #[repr(u32)]
  pub enum GovError {
      AlreadyInitialized = 1,
      NotInitialized     = 2,
      NotAdmin           = 3,
      ProposalNotFound   = 4,
      DeadlinePassed     = 5,
      DeadlineNotReached = 6,
      NullifierUsed      = 7,
      WrongProposalId    = 8,
      InvalidProof       = 9,
      StaleMerkleRoot    = 10,
      AlreadyRevealed    = 11,
      NotRevealed        = 12,
      RevealMismatch     = 13,
      AlreadyExecuted    = 14,
      NotApproved        = 15,
      // M1-additive plaintext errors (recorded divergence):
      AlreadyVoted       = 16, // plaintext double-vote by same voter
      NotEligible        = 17, // voter not in snapshot weight map
      ZeroWeight         = 18, // voter weight <= 0
      QuorumNotMet       = 19, // (reserved; close sets Rejected, does not error)
      InvalidDirection   = 20, // cast_vote direction was neither 0 (no) nor 1 (yes)
      ProposalAmountOverCap = 21, // create_proposal: action_spec.amount > cap (or <= 0)
      DeadlineInPast     = 22, // create_proposal: deadline <= current ledger timestamp
  }
  ```
  > The full `GovError` discriminants 1–15 are copied EXACTLY from foundation §2.2 (binding ABI). M1 adds 16–22; 19 is reserved (unused but kept so the number space is stable for M5). Discriminants 1–15 must NEVER change. **Why a dedicated `InvalidDirection = 20` (not `InvalidProof = 9`):** foundation §2.2 gives discriminant 9 the single binding meaning "groth16 verify returned false". M1 has no proof, so reusing code 9 for a malformed `direction` argument would overload a binding ABI code with a semantically wrong meaning and could confuse M4 callers/tests that match on `InvalidProof`. The M1-additive codes 20–22 exist precisely so M1 never overloads a binding discriminant. `ProposalAmountOverCap = 21` and `DeadlineInPast = 22` back the create-time cap/deadline invariants added in Task 4 (foundation §5 / §2.6: "amount bounded by proposal cap").
- [ ] 2.4 Create an empty test module so `mod test;` resolves: `contracts/gov-vault/src/test.rs`:
  ```rust
  #![cfg(test)]
  ```
- [ ] 2.5 Add the crate to the root workspace. Edit root `Cargo.toml` `[workspace] members` to include (alongside whatever M0 added):
  ```toml
  members = [
      "contracts/shared",
      "contracts/gov-vault",
      "contracts/swap-venue",
      "contracts/fallback-amm",
  ]
  ```
  > If `contracts/swap-venue` and `contracts/fallback-amm` do not exist yet, that is fine — they are created in Phase 6/7 and Cargo only errors on missing members at build time. To avoid a broken intermediate `cargo build`, you MAY add only `contracts/gov-vault` now and add the other two in Task 14 and Task 11 respectively. Pick one approach and be consistent. (Recommended: add `gov-vault` now; add the AMM/venue members in their tasks.)
- [ ] 2.6 Confirm it compiles:
  ```bash
  cargo build -p gov-vault 2>&1 | tail -10
  ```
  **Expected:** `Finished` (no errors). Warnings about unused `DataKey` variants are OK.
- [ ] 2.7 **COMMIT:**
  ```bash
  git add contracts/gov-vault Cargo.toml && git commit -m "$(printf 'build(gov-vault): scaffold crate with DataKey, GovError, GovVault contract\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 3 — `gov-vault::init`

### Task 3 — `init` sets admin, treasury asset, quorum cfg, voter weights; double-init rejects

**Files:** Modify `contracts/gov-vault/src/lib.rs` (add `init`), `contracts/gov-vault/src/storage.rs` (helpers). Tests in `contracts/gov-vault/src/test.rs`.

- [ ] 3.1 **RED.** Replace the contents of `contracts/gov-vault/src/test.rs` with a test harness + the `init` happy/double-init tests:
  ```rust
  #![cfg(test)]
  use crate::{GovVault, GovVaultClient, GovError};
  use shadowkit_shared::QuorumCfg;
  use soroban_sdk::{testutils::Address as _, Address, Env, Map};

  fn setup() -> (Env, GovVaultClient<'static>, Address, Address) {
      let env = Env::default();
      let contract_id = env.register(GovVault, ());
      let client = GovVaultClient::new(&env, &contract_id);
      let admin = Address::generate(&env);
      let usdc = Address::generate(&env);
      (env, client, admin, usdc)
  }

  /// Build a Map<Address,i128> of voter -> weight for the snapshot.
  fn weights(env: &Env, entries: &[(Address, i128)]) -> Map<Address, i128> {
      let mut m = Map::new(env);
      for (a, w) in entries.iter() {
          m.set(a.clone(), *w);
      }
      m
  }

  #[test]
  fn test_init_sets_state() {
      let (env, client, admin, usdc) = setup();
      let v1 = Address::generate(&env);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      // No panic == success. weight_of exposes the snapshot.
      assert_eq!(client.weight_of(&v1), 10);
  }

  #[test]
  fn test_double_init_rejects() {
      let (env, client, admin, usdc) = setup();
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      let res = client.try_init(&admin, &usdc, &cfg, &w);
      assert_eq!(res, Err(Ok(GovError::AlreadyInitialized)));
  }
  ```
  > `init`'s M1 signature differs from foundation §2.2's `init(env, admin, verifier, merkle_root, treasury_asset, quorum_cfg)` because M1 has no verifier/merkle_root (no ZK) and ADDS the plaintext voter-weight snapshot map. Recorded divergence (plan header). M4 reintroduces `verifier`/`merkle_root`.
- [ ] 3.2 Run and confirm RED:
  ```bash
  cargo test -p gov-vault test_init 2>&1 | tail -25
  ```
  **Expected (RED):** compile error: `no method named 'init' found` / `no function or associated item named 'weight_of'` on `GovVaultClient` (the methods don't exist yet). Build fails.
- [ ] 3.3 **GREEN.** Add storage helpers to `contracts/gov-vault/src/storage.rs` (append):
  ```rust
  use soroban_sdk::{Env, panic_with_error};
  use shadowkit_shared::QuorumCfg;
  use crate::GovError;

  pub fn is_initialized(env: &Env) -> bool {
      env.storage().instance().has(&DataKey::Admin)
  }
  pub fn set_admin(env: &Env, admin: &Address) {
      env.storage().instance().set(&DataKey::Admin, admin);
  }
  pub fn get_admin(env: &Env) -> Address {
      env.storage().instance().get(&DataKey::Admin)
          .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
  }
  pub fn set_treasury_asset(env: &Env, a: &Address) {
      env.storage().instance().set(&DataKey::TreasuryAsset, a);
  }
  pub fn set_quorum_cfg(env: &Env, cfg: &QuorumCfg) {
      env.storage().instance().set(&DataKey::QuorumCfg, cfg);
  }
  pub fn get_quorum_cfg(env: &Env) -> QuorumCfg {
      env.storage().instance().get(&DataKey::QuorumCfg)
          .unwrap_or_else(|| panic_with_error!(env, GovError::NotInitialized))
  }
  pub fn set_vote_weights(env: &Env, m: &Map<Address, i128>) {
      env.storage().instance().set(&DataKey::VoteWeights, m);
  }
  pub fn get_vote_weights(env: &Env) -> Map<Address, i128> {
      env.storage().instance().get(&DataKey::VoteWeights)
          .unwrap_or_else(|| Map::new(env))
  }
  ```
  Add `Map` to `storage.rs`'s top `use`: change it to
  ```rust
  use soroban_sdk::{contracttype, Address, BytesN, Map};
  ```
- [ ] 3.4 Add the `init` + `weight_of` entrypoints to `contracts/gov-vault/src/lib.rs`. Add a `#[contractimpl] impl GovVault { ... }` block:
  ```rust
  use soroban_sdk::{contractimpl, panic_with_error, Address, Env, Map};
  use shadowkit_shared::QuorumCfg;
  use crate::storage;

  #[contractimpl]
  impl GovVault {
      /// Initialize once. `vote_weights` is the M1 plaintext snapshot (voter -> token weight).
      /// Admin must auth. Default quorum_cfg per foundation §5: {min_voters:3, yes_must_exceed_no:true}.
      pub fn init(
          env: Env,
          admin: Address,
          treasury_asset: Address,
          quorum_cfg: QuorumCfg,
          vote_weights: Map<Address, i128>,
      ) {
          if storage::is_initialized(&env) {
              panic_with_error!(&env, GovError::AlreadyInitialized);
          }
          admin.require_auth();
          storage::set_admin(&env, &admin);
          storage::set_treasury_asset(&env, &treasury_asset);
          storage::set_quorum_cfg(&env, &quorum_cfg);
          storage::set_vote_weights(&env, &vote_weights);
          env.storage().instance().set(&storage::DataKey::NextId, &0u32);
      }

      /// Read a voter's snapshot weight (0 if not eligible). View; no auth.
      pub fn weight_of(env: Env, voter: Address) -> i128 {
          storage::get_vote_weights(&env).get(voter).unwrap_or(0)
      }
  }
  ```
  > `storage::DataKey` must be `pub` for this path. In `storage.rs` ensure `pub enum DataKey` (it is) and `pub struct ProposalRecord`. Also make the helper fns `pub` (they are written `pub fn`).
- [ ] 3.5 Run and confirm GREEN:
  ```bash
  cargo test -p gov-vault test_init 2>&1 | tail -12
  ```
  **Expected (GREEN):** `test test::test_init_sets_state ... ok`, `test test::test_double_init_rejects ... ok`, `test result: ok. 2 passed`.
- [ ] 3.6 **COMMIT:**
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'feat(gov-vault): init sets admin, treasury asset, quorum cfg, voter weights\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 4 — `gov-vault::create_proposal` + `proposal` read model

### Task 4 — `create_proposal` returns sequential ids, ENFORCES cap/deadline invariants; `proposal()` projects ProposalView with no early tally

**Files:** Modify `contracts/gov-vault/src/lib.rs`, `contracts/gov-vault/src/storage.rs`. Tests in `contracts/gov-vault/src/test.rs`.

- [ ] 4.1 **RED.** Append to `contracts/gov-vault/src/test.rs` a helper to build an `ActionSpec` and the create/read tests:
  ```rust
  use shadowkit_shared::{ActionSpec, SwapKind, ProposalStatus};

  fn sample_spec(env: &Env) -> ActionSpec {
      ActionSpec {
          kind: SwapKind::Swap,
          asset_in: Address::generate(env),
          asset_out: Address::generate(env),
          amount: 15_000,
          min_out: 14_000,
      }
  }

  fn init_default(env: &Env, client: &GovVaultClient, admin: &Address, usdc: &Address) {
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(env, &[]);
      env.mock_all_auths();
      client.init(admin, usdc, &cfg, &w);
  }

  #[test]
  fn test_create_proposal_sequential_ids() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      let spec = sample_spec(&env);
      let id0 = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
      let id1 = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
      assert_eq!(id0, 0);
      assert_eq!(id1, 1);
  }

  #[test]
  fn test_proposal_view_no_tally_before_close() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
      let view = client.proposal(&id);
      assert_eq!(view.id, id);
      assert_eq!(view.status, ProposalStatus::Open);
      assert_eq!(view.votes_cast, 0);
      assert_eq!(view.cap, 15_000);
      assert_eq!(view.deadline, 2_000_000_000);
      // BINDING invariant (foundation §2.2 / §7): no tally exposed before close.
      assert_eq!(view.weighted_yes, None);
      assert_eq!(view.weighted_no, None);
  }

  #[test]
  fn test_proposal_not_found() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      assert_eq!(client.try_proposal(&99u32), Err(Ok(GovError::ProposalNotFound)));
  }

  // INVARIANT (foundation §5 / §2.6: "amount bounded by proposal cap"; spec §9 "ActionSpec: cap bounds amount"):
  // create_proposal MUST reject a spec whose amount exceeds cap (and a non-positive amount), so the
  // cap invariant AgentPolicy (M2) and the safeguard "amount <= proposal cap" depend on cannot be
  // silently violated at create time.
  #[test]
  fn test_create_proposal_rejects_amount_over_cap() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      // spec.amount = 15_000 but cap = 10_000 -> amount > cap -> reject
      let spec = sample_spec(&env); // amount 15_000
      let res = client.try_create_proposal(&spec, &10_000i128, &2_000_000_000u64);
      assert_eq!(res, Err(Ok(GovError::ProposalAmountOverCap)));
  }

  #[test]
  fn test_create_proposal_rejects_nonpositive_amount() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      let mut spec = sample_spec(&env);
      spec.amount = 0; // amount must be strictly positive (0 <= cap, but a 0-amount swap is invalid)
      // the impl rejects amount <= 0 with the SAME error code as amount > cap (ProposalAmountOverCap)
      let res = client.try_create_proposal(&spec, &10_000i128, &2_000_000_000u64);
      assert_eq!(res, Err(Ok(GovError::ProposalAmountOverCap)));
  }

  // INVARIANT: deadline must be strictly in the future relative to the current ledger timestamp,
  // otherwise the proposal is born un-votable and close() could run immediately.
  #[test]
  fn test_create_proposal_rejects_past_deadline() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      // Advance ledger time to 1_000; a deadline of 1_000 (== now) or earlier must be rejected.
      // (set_time helper is introduced in Task 5.1; until then, set the ledger inline here.)
      env.ledger().set(soroban_sdk::testutils::LedgerInfo {
          timestamp: 1_000,
          protocol_version: 25,
          sequence_number: 10,
          network_id: [0; 32],
          base_reserve: 10,
          min_temp_entry_ttl: 16,
          min_persistent_entry_ttl: 16,
          max_entry_ttl: 10_000_000,
      });
      let spec = sample_spec(&env);
      let res = client.try_create_proposal(&spec, &15_000i128, &1_000u64); // deadline == now
      assert_eq!(res, Err(Ok(GovError::DeadlineInPast)));
  }
  ```
  > `LedgerInfo` is `soroban_sdk::testutils::LedgerInfo`; using it requires the `testutils` feature (already in `gov-vault` dev-deps, Task 2.1). The fully-qualified path is used here because Task 4 runs before Task 5.1 adds the `use soroban_sdk::testutils::{Ledger, LedgerInfo};` import; if you prefer, add that `use` line to `test.rs` now.
- [ ] 4.2 Run, confirm RED:
  ```bash
  cargo test -p gov-vault test_create_proposal_sequential_ids test_proposal_view_no_tally_before_close test_proposal_not_found test_create_proposal_rejects_amount_over_cap test_create_proposal_rejects_nonpositive_amount test_create_proposal_rejects_past_deadline 2>&1 | tail -20
  ```
  **Expected (RED):** `no method named 'create_proposal'` / `no method named 'try_create_proposal'` / `no method named 'proposal'` on the client (none of the entrypoints exist yet). Build fails — a genuine red for all six tests.
- [ ] 4.3 **GREEN.** Add proposal storage helpers to `storage.rs` (append):
  ```rust
  use shadowkit_shared::{ProposalView, ProposalStatus};

  pub fn next_id(env: &Env) -> u32 {
      let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
      env.storage().instance().set(&DataKey::NextId, &(id + 1));
      id
  }
  pub fn set_proposal(env: &Env, id: u32, rec: &ProposalRecord) {
      env.storage().persistent().set(&DataKey::Proposal(id), rec);
  }
  pub fn get_proposal(env: &Env, id: u32) -> ProposalRecord {
      env.storage().persistent().get(&DataKey::Proposal(id))
          .unwrap_or_else(|| panic_with_error!(env, GovError::ProposalNotFound))
  }
  pub fn try_get_proposal(env: &Env, id: u32) -> Option<ProposalRecord> {
      env.storage().persistent().get(&DataKey::Proposal(id))
  }
  pub fn to_view(id: u32, rec: &ProposalRecord) -> ProposalView {
      ProposalView {
          id,
          action_spec: rec.action_spec.clone(),
          cap: rec.cap,
          deadline: rec.deadline,
          votes_cast: rec.votes_cast,
          status: rec.status.clone(),
          weighted_yes: rec.weighted_yes,
          weighted_no: rec.weighted_no,
      }
  }
  ```
- [ ] 4.4 Add `create_proposal` + `proposal` + `votes_cast` to `lib.rs`'s `impl GovVault` block:
  ```rust
  use shadowkit_shared::{ActionSpec, ProposalView, ProposalStatus};
  use crate::storage::ProposalRecord;

  // (inside impl GovVault)

  /// Create a proposal. Sequential u32 id starting at 0. `cap` bounds ActionSpec.amount;
  /// `deadline` = unix-seconds ledger timestamp. Admin auth required.
  /// INVARIANTS (foundation §5 / §2.6 / spec §9): ActionSpec.amount must be in (0, cap]; the
  /// deadline must be strictly in the future. These guarantee the cap invariant that AgentPolicy
  /// (M2) and the safeguard "amount <= proposal cap" rely on, and that the proposal is votable.
  pub fn create_proposal(env: Env, action_spec: ActionSpec, cap: i128, deadline: u64) -> u32 {
      let admin = storage::get_admin(&env);
      admin.require_auth();
      // cap invariant: 0 < amount <= cap
      if action_spec.amount <= 0 || action_spec.amount > cap {
          panic_with_error!(&env, GovError::ProposalAmountOverCap);
      }
      // deadline must be in the future
      if deadline <= env.ledger().timestamp() {
          panic_with_error!(&env, GovError::DeadlineInPast);
      }
      let id = storage::next_id(&env);
      let rec = ProposalRecord {
          action_spec,
          cap,
          deadline,
          status: ProposalStatus::Open,
          weighted_yes: None,
          weighted_no: None,
          votes_cast: 0,
          executed: false,
      };
      storage::set_proposal(&env, id, &rec);
      env.storage().persistent().set(&storage::DataKey::YesWeight(id), &0i128);
      env.storage().persistent().set(&storage::DataKey::NoWeight(id), &0i128);
      crate::ProposalCreated { id, deadline, cap }.publish(&env);
      id
  }

  /// Full read model. weighted_yes/no are None until close. Never leaks tally early.
  pub fn proposal(env: Env, id: u32) -> ProposalView {
      let rec = storage::get_proposal(&env, id);
      storage::to_view(id, &rec)
  }

  /// Participation count (safe — no direction).
  pub fn votes_cast(env: Env, id: u32) -> u32 {
      storage::get_proposal(&env, id).votes_cast
  }
  ```
- [ ] 4.5 Add the `ProposalCreated` event (foundation §2.2) to `lib.rs` (top level, after the `GovError` enum):
  ```rust
  use soroban_sdk::contractevent;

  #[contractevent]
  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct ProposalCreated { #[topic] pub id: u32, pub deadline: u64, pub cap: i128 }
  ```
- [ ] 4.6 Run, confirm GREEN:
  ```bash
  cargo test -p gov-vault test_create_proposal_sequential_ids test_proposal_view_no_tally_before_close test_proposal_not_found test_create_proposal_rejects_amount_over_cap test_create_proposal_rejects_nonpositive_amount test_create_proposal_rejects_past_deadline 2>&1 | tail -14
  ```
  **Expected (GREEN):** all six `... ok`, `test result: ok. 6 passed`.
- [ ] 4.7 **COMMIT:**
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'feat(gov-vault): create_proposal sequential ids, cap/deadline invariants, ProposalView read model\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 5 — `gov-vault::cast_vote` (PLAINTEXT) + guards

### Task 5 — `cast_vote`: ALL behaviors written RED first (happy + double-vote + post-deadline + ineligible + bad-direction), then ONE implementation

**Files:** Modify `contracts/gov-vault/src/lib.rs`, `contracts/gov-vault/src/storage.rs`. Tests in `contracts/gov-vault/src/test.rs`.

> **TDD note (fixes the prior plan's regression-lock anti-pattern):** the earlier draft implemented every `cast_vote` guard in one step and then "locked" each guard in a later test that *passed on first run* (no prior red) — which foundation §7 rule 4 declares INVALID ("a task that goes green on first run without a prior red is invalid"). This task instead writes ALL five `cast_vote` behavior tests (the happy path AND the four guards: double-vote, post-deadline, ineligible, bad-direction) BEFORE any `cast_vote` code exists, so every test gets a genuine compile-level red (the method does not exist), then a single minimal implementation turns them all green together. There are no standalone "lock" tasks afterward.

- [ ] 5.1 **RED.** Append the ledger-time helper and ALL FIVE `cast_vote` tests to `contracts/gov-vault/src/test.rs`. None of `cast_vote` exists yet, so the whole module fails to compile — a real red:
  ```rust
  use soroban_sdk::testutils::{Ledger, LedgerInfo};

  fn set_time(env: &Env, ts: u64) {
      env.ledger().set(LedgerInfo {
          timestamp: ts,
          protocol_version: 25,
          sequence_number: 10,
          network_id: [0; 32],
          base_reserve: 10,
          min_temp_entry_ttl: 16,
          min_persistent_entry_ttl: 16,
          max_entry_ttl: 10_000_000,
      });
  }

  // (1) happy path: auth + weight lookup + participation bump, no tally leak
  #[test]
  fn test_cast_vote_happy_updates_participation() {
      let (env, client, admin, usdc) = setup();
      let v1 = Address::generate(&env);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &5_000u64); // deadline far ahead
      // direction 1 = yes
      client.cast_vote(&id, &v1, &1u32);
      assert_eq!(client.votes_cast(&id), 1);
      // still no public tally before close
      let view = client.proposal(&id);
      assert_eq!(view.weighted_yes, None);
      assert_eq!(view.weighted_no, None);
  }

  // (2) double-vote by the SAME voter (plaintext analogue of nullifier reuse) -> AlreadyVoted
  #[test]
  fn test_double_vote_same_voter_rejected() {
      let (env, client, admin, usdc) = setup();
      let v1 = Address::generate(&env);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &5_000u64);
      client.cast_vote(&id, &v1, &1u32);
      // second vote by the SAME voter (even with a different direction) must be rejected
      let res = client.try_cast_vote(&id, &v1, &0u32);
      assert_eq!(res, Err(Ok(GovError::AlreadyVoted)));
      // participation unchanged
      assert_eq!(client.votes_cast(&id), 1);
  }

  // (3) post-deadline vote -> DeadlinePassed
  #[test]
  fn test_post_deadline_vote_rejected() {
      let (env, client, admin, usdc) = setup();
      let v1 = Address::generate(&env);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000u64); // deadline = 2000
      set_time(&env, 2_001); // advance ledger time PAST the deadline
      let res = client.try_cast_vote(&id, &v1, &1u32);
      assert_eq!(res, Err(Ok(GovError::DeadlinePassed)));
      assert_eq!(client.votes_cast(&id), 0);
  }

  // (4) ineligible voter (not in the snapshot map) -> NotEligible
  #[test]
  fn test_ineligible_voter_rejected() {
      let (env, client, admin, usdc) = setup();
      let v1 = Address::generate(&env);        // eligible
      let intruder = Address::generate(&env);  // NOT in snapshot
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &5_000u64);
      let res = client.try_cast_vote(&id, &intruder, &1u32);
      assert_eq!(res, Err(Ok(GovError::NotEligible)));
      assert_eq!(client.votes_cast(&id), 0);
  }

  // (5) malformed direction (neither 0 nor 1) -> InvalidDirection (M1-additive; NOT InvalidProof)
  #[test]
  fn test_bad_direction_rejected() {
      let (env, client, admin, usdc) = setup();
      let v1 = Address::generate(&env);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &5_000u64);
      // direction 2 is invalid; must be a dedicated InvalidDirection error (discriminant 20),
      // NOT the binding InvalidProof (discriminant 9, whose meaning is "groth16 verify false").
      let res = client.try_cast_vote(&id, &v1, &2u32);
      assert_eq!(res, Err(Ok(GovError::InvalidDirection)));
      assert_eq!(client.votes_cast(&id), 0);
  }
  ```
- [ ] 5.2 Run, confirm RED (ALL FIVE tests fail because `cast_vote` does not exist yet):
  ```bash
  cargo test -p gov-vault test_cast_vote_happy_updates_participation test_double_vote_same_voter_rejected test_post_deadline_vote_rejected test_ineligible_voter_rejected test_bad_direction_rejected 2>&1 | tail -25
  ```
  **Expected (RED):** compile error `no method named 'cast_vote' found for struct 'GovVaultClient'` / `no method named 'try_cast_vote'`. Build fails — a genuine red for every one of the five tests.
- [ ] 5.3 **GREEN.** Add vote storage helpers to `storage.rs` (append):
  ```rust
  pub fn has_voted(env: &Env, id: u32, voter: &Address) -> bool {
      env.storage().persistent().has(&DataKey::VoterVoted(id, voter.clone()))
  }
  pub fn mark_voted(env: &Env, id: u32, voter: &Address) {
      env.storage().persistent().set(&DataKey::VoterVoted(id, voter.clone()), &());
  }
  pub fn add_yes(env: &Env, id: u32, w: i128) {
      let cur: i128 = env.storage().persistent().get(&DataKey::YesWeight(id)).unwrap_or(0);
      env.storage().persistent().set(&DataKey::YesWeight(id), &(cur + w));
  }
  pub fn add_no(env: &Env, id: u32, w: i128) {
      let cur: i128 = env.storage().persistent().get(&DataKey::NoWeight(id)).unwrap_or(0);
      env.storage().persistent().set(&DataKey::NoWeight(id), &(cur + w));
  }
  pub fn get_yes(env: &Env, id: u32) -> i128 {
      env.storage().persistent().get(&DataKey::YesWeight(id)).unwrap_or(0)
  }
  pub fn get_no(env: &Env, id: u32) -> i128 {
      env.storage().persistent().get(&DataKey::NoWeight(id)).unwrap_or(0)
  }
  ```
- [ ] 5.4 Add the `cast_vote` entrypoint to `lib.rs`'s `impl GovVault`. **M1 plaintext signature** (recorded divergence from foundation §2.2 sealed signature; documented in plan header):
  ```rust
  use soroban_sdk::BytesN;

  /// PLAINTEXT vote (M1). `voter` must auth; `direction` is 1 (yes) or 0 (no).
  /// Reads the voter's snapshot weight, prevents double-vote, enforces deadline,
  /// updates the running plaintext tally (kept private until `close`), bumps participation.
  /// M4/M5 REPLACE this with the sealed signature (foundation §2.2).
  pub fn cast_vote(env: Env, id: u32, voter: Address, direction: u32) {
      voter.require_auth();
      let mut rec = storage::get_proposal(&env, id);
      // deadline: cast must be at/before deadline
      if env.ledger().timestamp() > rec.deadline {
          panic_with_error!(&env, GovError::DeadlinePassed);
      }
      // direction must be a bit (0 or 1). Use a DEDICATED M1-additive error, NOT the binding
      // InvalidProof (code 9, whose foundation §2.2 meaning is "groth16 verify returned false").
      if direction != 0 && direction != 1 {
          panic_with_error!(&env, GovError::InvalidDirection);
      }
      // eligibility + weight
      let weight = storage::get_vote_weights(&env).get(voter.clone()).unwrap_or(0);
      if weight <= 0 {
          panic_with_error!(&env, GovError::NotEligible);
      }
      // double-vote guard (plaintext analogue of nullifier)
      if storage::has_voted(&env, id, &voter) {
          panic_with_error!(&env, GovError::AlreadyVoted);
      }
      storage::mark_voted(&env, id, &voter);
      if direction == 1 {
          storage::add_yes(&env, id, weight);
      } else {
          storage::add_no(&env, id, weight);
      }
      rec.votes_cast += 1;
      storage::set_proposal(&env, id, &rec);
      // VoteCast event: foundation §2.2 uses BytesN<32> nullifier; M1 has no nullifier,
      // so we emit a deterministic voter-derived 32-byte id (sha256 of the voter's XDR bytes) to keep
      // the binding event shape stable. Recorded divergence.
      // .to_bytes() is the documented Hash<32> -> BytesN<32> conversion (NOT .into()):
      //   env.crypto().sha256(&data).to_bytes()  (verified: rs-soroban-sdk crypto example,
      //   soroban-sdk/src/tests, 2026-06-02).
      let voter_id: BytesN<32> = env.crypto().sha256(&voter.clone().to_xdr(&env)).to_bytes();
      crate::VoteCast { id, nullifier: voter_id }.publish(&env);
  }
  ```
  > **`to_xdr` import + verification:** add `use soroban_sdk::xdr::ToXdr;` to `lib.rs`. **VERIFIED no_std availability (2026-06-02):** `soroban_sdk::xdr` is declared `pub mod xdr;` in `soroban-sdk/src/lib.rs` with **no `#[cfg(feature)]` gate**, and `ToXdr` is a **blanket impl** `impl<T> ToXdr for T where T: IntoVal<Env, Val> { fn to_xdr(self, env: &Env) -> Bytes }` backed by the `env.serialize_to_bytes` host function (SOURCE: `gh api repos/stellar/rs-soroban-sdk/.../src/xdr.rs`, raw GitHub 2026-06-02). `Address: IntoVal<Env, Val>`, so `voter.clone().to_xdr(&env)` compiles and runs in a `#[no_std]` cdylib targeting `wasm32v1-none` — this is a genuine, verified primary, not an unverified path. Note `to_xdr` takes `self` by value (hence `voter.clone()`). **`.to_bytes()` (NOT `.into()`):** `env.crypto().sha256(&bytes)` returns `Hash<32>`; its documented conversion to `BytesN<32>` is `.to_bytes()` (SOURCE: rs-soroban-sdk crypto docs/example, `env.crypto().sha256(&data).to_bytes()`, 2026-06-02). `.into()` is not a documented conversion and must not be used.
- [ ] 5.5 Add the `VoteCast` event (foundation §2.2) to `lib.rs` (after `ProposalCreated`):
  ```rust
  #[contractevent]
  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct VoteCast { #[topic] pub id: u32, pub nullifier: BytesN<32> } // no direction/weight
  ```
- [ ] 5.6 Run ALL FIVE `cast_vote` tests, confirm they all turn GREEN together (one minimal impl satisfied every prior red):
  ```bash
  cargo test -p gov-vault test_cast_vote_happy_updates_participation test_double_vote_same_voter_rejected test_post_deadline_vote_rejected test_ineligible_voter_rejected test_bad_direction_rejected 2>&1 | tail -14
  ```
  **Expected (GREEN):**
  ```
  test test::test_cast_vote_happy_updates_participation ... ok
  test test::test_double_vote_same_voter_rejected ... ok
  test test::test_post_deadline_vote_rejected ... ok
  test test::test_ineligible_voter_rejected ... ok
  test test::test_bad_direction_rejected ... ok
  test result: ok. 5 passed; 0 failed; 0 ignored
  ```
- [ ] 5.7 **COMMIT** (the whole red→green `cast_vote` cycle — happy path + all four guards — is one TDD cycle, so one commit):
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'feat(gov-vault): plaintext cast_vote with auth, weight, double-vote/deadline/eligibility/direction guards\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 6 — `cast_vote` emits a `VoteCast` event with the correct binding payload

> **Why this replaces the old "regression-lock" Tasks 6-8:** the prior draft re-tested the double-vote / deadline / eligibility guards in three separate tasks that admitted they would PASS on first run (no prior red) — an invalid green-on-first-run per foundation §7 rule 4. Those four guards are now written RED-first inside Task 5.1 and turned green once in Task 5.6, so they need no separate "lock" tasks. This Task 6 instead covers a genuinely new, untested public behavior: the `VoteCast` **event emission** (foundation §2.2 / §7 rule 1 — every public observable behavior must be tested), which gets a real red (the assertion fails until the event payload is correct).

**Files:** Test only — `contracts/gov-vault/src/test.rs`.

> **How this task keeps a genuine red (no green-on-first-run):** author `test_cast_vote_emits_votecast_event` (below) at the SAME time as the Task 5.1 batch — i.e. BEFORE any `cast_vote`/`VoteCast` code exists. At that point the test references `crate::VoteCast`, `client.cast_vote`, and `event.topics(&env)` which do not yet exist, so it fails to compile (a real red) alongside the five Task-5.1 tests. It then turns green when Task 5.4's `.publish(&env)` line and Task 5.5's `VoteCast` definition land. This task's checkboxes are written for the moment you VERIFY that red→green specifically for the event payload. Do NOT add this test after Task 5 is already green (that would be a green-on-first-run); add it in the Task 5.1 batch and only RUN/verify it here.

- [ ] 6.1 **RED.** Ensure the following test is present in the Task 5.1 batch (added before any `cast_vote` impl). The verified soroban-sdk pattern compares `env.events().all()` against a `Vec<(Address, topics: Vec<Val>, data: Val)>` built from the typed event's own `.topics(&env)` / `.data(&env)` methods (SOURCE: rs-soroban-sdk `soroban-sdk/src/tests/contract_event.rs::test_event_comparison_tuple_vec`, raw GitHub 2026-06-02). The scenario uses a single eligible voter so the emitted-events list is deterministic — exactly `[ProposalCreated, VoteCast]`:
  ```rust
  use soroban_sdk::{vec, Event};

  #[test]
  fn test_cast_vote_emits_votecast_event() {
      let (env, client, admin, usdc) = setup();
      let contract_id = client.address.clone();
      let v1 = Address::generate(&env);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[(v1.clone(), 10)]);
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &5_000u64);
      client.cast_vote(&id, &v1, &1u32);

      // The contract derives the event's BytesN<32> id the SAME way the impl does:
      //   sha256(voter.to_xdr(&env)).to_bytes()  (verified Hash<32>->BytesN<32> via .to_bytes()).
      let expected_nullifier: soroban_sdk::BytesN<32> =
          env.crypto().sha256(&v1.clone().to_xdr(&env)).to_bytes();
      let created = crate::ProposalCreated { id, deadline: 5_000u64, cap: 15_000i128 };
      let vote_cast = crate::VoteCast { id, nullifier: expected_nullifier };

      // The full ordered events list after create + one vote: [ProposalCreated, VoteCast].
      assert_eq!(
          env.events().all(),
          vec![
              &env,
              (contract_id.clone(), created.topics(&env), created.data(&env)),
              (contract_id.clone(), vote_cast.topics(&env), vote_cast.data(&env)),
          ]
      );
  }
  ```
  > `use soroban_sdk::xdr::ToXdr;` must be in scope in the test module (add `use soroban_sdk::xdr::ToXdr;` at the top of `test.rs`). `Event` is the trait that provides `.topics(&env)`/`.data(&env)` on `#[contractevent]` structs (SOURCE: rs-soroban-sdk `soroban-sdk/src/tests/contract_event.rs` imports `Event`). `ProposalCreated` carries `deadline=5_000`/`cap=15_000` because that is exactly what `create_proposal` published in this scenario.
- [ ] 6.2 Run, confirm RED. Because this test was authored in the Task 5.1 batch (before `cast_vote`, `VoteCast`, and the `.publish(&env)` line exist), it fails. Run it on its own to capture the red:
  ```bash
  cargo test -p gov-vault test_cast_vote_emits_votecast_event 2>&1 | tail -20
  ```
  **Expected (RED):** before any `cast_vote` code → compile error `cannot find type 'VoteCast' in this scope` / `no method named 'cast_vote'`. (If you instead implement `cast_vote` storage/auth WITHOUT the `.publish(&env)` line, the red becomes an assertion failure: `assertion 'left == right' failed`, left = `[ProposalCreated]` (one tuple), right = `[ProposalCreated, VoteCast]` (two tuples).) Either is a genuine, pre-implementation red for the event-emission behavior.
- [ ] 6.3 **GREEN.** The behavior is implemented by Task 5.5's `VoteCast` definition and Task 5.4's `crate::VoteCast { id, nullifier: voter_id }.publish(&env);` line. Once both are present (Task 5 done), run:
  ```bash
  cargo test -p gov-vault test_cast_vote_emits_votecast_event 2>&1 | tail -10
  ```
  **Expected (GREEN):** `test test::test_cast_vote_emits_votecast_event ... ok`, `1 passed`.
- [ ] 6.4 **COMMIT:**
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'test(gov-vault): assert cast_vote emits VoteCast event with correct payload\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

> **Numbering note:** Tasks 7 and 8 of the previous draft (standalone "lock" tests for the double-vote and ineligible guards) were REMOVED — those guards are now written RED-first in Task 5.1 and turned green in Task 5.6 (no green-on-first-run). The next task is Task 9. The numbers 7 and 8 are intentionally vacant; do not look for them.

---

## Phase 6 — `gov-vault::close` (plaintext tally + quorum, Task 9) + read accessors (Task 9B) + `mark_executed` (Task 10)

### Task 9 — `close` computes the weighted tally, applies QuorumCfg, sets Approved/Rejected, emits `ProposalClosed`

> **Scope (fixes the prior plan's over-bundled Task 9):** this task implements ONLY `close` (the tally + quorum decision + the watcher-critical `ProposalClosed` event). The three read accessors (`is_approved`, `cap_of`, `action_of`) are split into **Task 9B** with their own focused reds (including the `ProposalNotFound` negative paths foundation §2.2 requires). This keeps each red focused on one method's failing behavior, per the plan's "one commit per completed TDD cycle" cadence.
>
> **ProposalStatus::Tallying divergence (recorded, intentional):** foundation §2.6 / spec §9 define `ProposalStatus` with a `Tallying` state between `Open` and `Approved`/`Rejected`. M1's `close` is a **single-shot plaintext** transition: it computes the whole tally atomically in one call, so there is no observable intermediate window and M1 transitions `Open -> Approved|Rejected` directly. `Tallying` is therefore defined in the binding enum (kept verbatim so the discriminant order never changes) but UNUSED in M1. M5's sealed `close_and_reveal` — which performs multi-step on-chain re-aggregation — is where `Tallying` becomes observable. This is a deliberate, traceable divergence (the same style as the `min_out`/`min_out_policy` and `VoteModal`/`RevealedResult` notes), not an oversight; no M1 test asserts `Tallying`.

**Files:** Modify `contracts/gov-vault/src/lib.rs`. Tests in `contracts/gov-vault/src/test.rs`.

- [ ] 9.1 **RED.** Append the shared `vote_scenario` helper and the close tests (quorum-pass, quorum-fail ×2, before-deadline, double-close, AND a `ProposalClosed` event-payload assertion — the event the agent watcher subscribes to, foundation §2.2):
  ```rust
  /// Cast `n` yes votes and `m` no votes with distinct eligible voters of weight 10 each.
  fn vote_scenario(env: &Env, client: &GovVaultClient, admin: &Address, usdc: &Address,
                   yes: u32, no: u32, deadline: u64) -> u32 {
      let mut entries: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(env);
      let mut wmap = Map::new(env);
      let total = yes + no;
      for _ in 0..total {
          let a = Address::generate(env);
          wmap.set(a.clone(), 10i128);
          entries.push_back(a);
      }
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      env.mock_all_auths();
      client.init(admin, usdc, &cfg, &wmap);
      set_time(env, 1_000);
      let spec = sample_spec(env);
      let id = client.create_proposal(&spec, &15_000i128, &deadline);
      for i in 0..yes {
          client.cast_vote(&id, &entries.get(i).unwrap(), &1u32);
      }
      for i in yes..total {
          client.cast_vote(&id, &entries.get(i).unwrap(), &0u32);
      }
      id
  }

  #[test]
  fn test_close_quorum_pass_sets_approved() {
      let (env, client, admin, usdc) = setup();
      // 3 yes (weight 30), 0 no -> yes>no AND voters(3) >= min_voters(3) -> APPROVED
      let id = vote_scenario(&env, &client, &admin, &usdc, 3, 0, 2_000);
      set_time(&env, 2_001); // past deadline
      client.close(&id);
      let view = client.proposal(&id);
      assert_eq!(view.status, ProposalStatus::Approved);
      assert_eq!(view.weighted_yes, Some(30));
      assert_eq!(view.weighted_no, Some(0));
  }

  #[test]
  fn test_close_quorum_fail_low_participation() {
      let (env, client, admin, usdc) = setup();
      // 2 yes only -> votes_cast(2) < min_voters(3) -> REJECTED even though yes>no
      let id = vote_scenario(&env, &client, &admin, &usdc, 2, 0, 2_000);
      set_time(&env, 2_001);
      client.close(&id);
      let view = client.proposal(&id);
      assert_eq!(view.status, ProposalStatus::Rejected);
  }

  #[test]
  fn test_close_quorum_fail_no_majority() {
      let (env, client, admin, usdc) = setup();
      // 1 yes, 2 no -> votes_cast(3) >= 3 but yes(10) !> no(20) -> REJECTED
      let id = vote_scenario(&env, &client, &admin, &usdc, 1, 2, 2_000);
      set_time(&env, 2_001);
      client.close(&id);
      let view = client.proposal(&id);
      assert_eq!(view.status, ProposalStatus::Rejected);
      assert_eq!(view.weighted_yes, Some(10));
      assert_eq!(view.weighted_no, Some(20));
  }

  #[test]
  fn test_close_before_deadline_rejected() {
      let (env, client, admin, usdc) = setup();
      let id = vote_scenario(&env, &client, &admin, &usdc, 3, 0, 5_000);
      set_time(&env, 1_500); // before deadline 5000
      assert_eq!(client.try_close(&id), Err(Ok(GovError::DeadlineNotReached)));
  }

  #[test]
  fn test_close_twice_rejected() {
      let (env, client, admin, usdc) = setup();
      let id = vote_scenario(&env, &client, &admin, &usdc, 3, 0, 2_000);
      set_time(&env, 2_001);
      client.close(&id);
      assert_eq!(client.try_close(&id), Err(Ok(GovError::AlreadyRevealed)));
  }

  // The agent watcher (foundation §2.2: "ProposalClosed is the event the agent watcher subscribes to")
  // depends on this exact payload. Assert it is emitted with the correct id/approved/weighted_yes/no.
  // To keep the emitted-events list deterministic we use a fresh proposal with NO voters, so the only
  // events are [ProposalCreated, ProposalClosed]; close with 0 voters -> approved=false (quorum fail).
  #[test]
  fn test_close_emits_proposalclosed_event() {
      use soroban_sdk::{vec, Event};
      let (env, client, admin, usdc) = setup();
      let contract_id = client.address.clone();
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      let w = weights(&env, &[]); // no eligible voters
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000u64);
      set_time(&env, 2_001);
      client.close(&id);

      // approved=false (0 voters < min 3), weighted_yes=0, weighted_no=0
      let created = crate::ProposalCreated { id, deadline: 2_000u64, cap: 15_000i128 };
      let closed = crate::ProposalClosed { id, approved: false, weighted_yes: 0i128, weighted_no: 0i128 };
      assert_eq!(
          env.events().all(),
          vec![
              &env,
              (contract_id.clone(), created.topics(&env), created.data(&env)),
              (contract_id.clone(), closed.topics(&env), closed.data(&env)),
          ]
      );
  }

  // Approve-path event payload: a passing proposal emits ProposalClosed{approved:true, weighted_yes, weighted_no}.
  // Deterministic event list: fresh init with exactly the voters this scenario uses.
  #[test]
  fn test_close_emits_proposalclosed_event_approved() {
      use soroban_sdk::Event;
      let (env, client, admin, usdc) = setup();
      let contract_id = client.address.clone();
      let v1 = Address::generate(&env);
      let v2 = Address::generate(&env);
      let v3 = Address::generate(&env);
      let w = weights(&env, &[(v1.clone(), 10), (v2.clone(), 10), (v3.clone(), 10)]);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000u64);
      client.cast_vote(&id, &v1, &1u32);
      client.cast_vote(&id, &v2, &1u32);
      client.cast_vote(&id, &v3, &1u32);
      set_time(&env, 2_001);
      client.close(&id);

      // The LAST emitted event must be the approved ProposalClosed. We compare it directly by
      // indexing the XDR slice's last entry against the typed event's to_xdr form.
      let closed = crate::ProposalClosed { id, approved: true, weighted_yes: 30i128, weighted_no: 0i128 };
      let all = env.events().all();
      let xdr_events = all.events(); // &[xdr::ContractEvent], oldest -> newest
      let last = xdr_events.last().unwrap().clone();
      assert_eq!(last, closed.to_xdr(&env, &contract_id));
  }
  ```
  > The first event test compares the WHOLE events list (`Vec<(Address, topics, data)>`) — valid because the no-voter scenario emits exactly two events. The second uses the per-event `Event::to_xdr(&env, &contract_id)` round-trip against `ContractEvents::events()` (the `&[xdr::ContractEvent]` slice) and indexes `.last()`, because the 3-vote scenario also emits 3 `VoteCast` events and we only want to assert the final `ProposalClosed`. Both APIs are verified: `ContractEvents` impls `PartialEq<Vec<(Address, Vec<Val>, Val)>>` and exposes `events() -> &[xdr::ContractEvent]`; the typed `#[contractevent]` provides `Event::topics`/`Event::data`/`Event::to_xdr` (SOURCE: rs-soroban-sdk `soroban-sdk/src/tests/contract_event.rs` `test_event_comparison_tuple_vec` + `test_data_map` which use `event.to_xdr(&env, &id)`, raw GitHub 2026-06-02).
- [ ] 9.2 Run, confirm RED:
  ```bash
  cargo test -p gov-vault test_close 2>&1 | tail -20
  ```
  **Expected (RED):** `no method named 'close'` on `GovVaultClient`, and `cannot find type 'ProposalClosed'` (event not defined yet). Build fails — a genuine red for all seven close tests.
- [ ] 9.3 **GREEN.** Add ONLY `close` to `impl GovVault` (the read accessors `is_approved`/`cap_of`/`action_of` are Task 9B):
  ```rust
  /// Close after deadline: compute plaintext weighted tally from running yes/no weights,
  /// apply QuorumCfg (yes>no AND votes_cast>=min_voters), set Approved|Rejected. Single close only.
  /// M1 PLAINTEXT analogue of foundation §2.2 close_and_reveal (no sealed votes / re-aggregation).
  /// DIVERGENCE (recorded, see task header): M1 transitions Open -> Approved|Rejected atomically and
  /// never sets ProposalStatus::Tallying (no observable intermediate window in single-shot plaintext
  /// close). M5's multi-step close_and_reveal is where Tallying becomes observable.
  pub fn close(env: Env, id: u32) {
      let mut rec = storage::get_proposal(&env, id);
      if rec.weighted_yes.is_some() {
          panic_with_error!(&env, GovError::AlreadyRevealed);
      }
      if env.ledger().timestamp() <= rec.deadline {
          panic_with_error!(&env, GovError::DeadlineNotReached);
      }
      let yes = storage::get_yes(&env, id);
      let no = storage::get_no(&env, id);
      let cfg = storage::get_quorum_cfg(&env);
      let majority_ok = if cfg.yes_must_exceed_no { yes > no } else { yes >= no };
      let participation_ok = rec.votes_cast >= cfg.min_voters;
      let approved = majority_ok && participation_ok;
      rec.weighted_yes = Some(yes);
      rec.weighted_no = Some(no);
      rec.status = if approved { ProposalStatus::Approved } else { ProposalStatus::Rejected };
      storage::set_proposal(&env, id, &rec);
      crate::ProposalClosed { id, approved, weighted_yes: yes, weighted_no: no }.publish(&env);
  }
  ```
- [ ] 9.4 Add the `ProposalClosed` event (foundation §2.2) to `lib.rs`:
  ```rust
  #[contractevent]
  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct ProposalClosed { #[topic] pub id: u32, pub approved: bool, pub weighted_yes: i128, pub weighted_no: i128 }
  ```
- [ ] 9.5 Run, confirm GREEN:
  ```bash
  cargo test -p gov-vault test_close 2>&1 | tail -15
  ```
  **Expected (GREEN):** `test_close_quorum_pass_sets_approved ... ok`, `test_close_quorum_fail_low_participation ... ok`, `test_close_quorum_fail_no_majority ... ok`, `test_close_before_deadline_rejected ... ok`, `test_close_twice_rejected ... ok`, `test_close_emits_proposalclosed_event ... ok`, `test_close_emits_proposalclosed_event_approved ... ok`. `7 passed`.
- [ ] 9.6 **COMMIT:**
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'feat(gov-vault): close computes weighted tally, applies quorum, emits ProposalClosed\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 9B — read accessors `is_approved` / `cap_of` / `action_of` (incl. `ProposalNotFound` negatives)

**Files:** Modify `contracts/gov-vault/src/lib.rs`. Tests in `contracts/gov-vault/src/test.rs`.

- [ ] 9B.1 **RED.** Append focused tests for the three AgentPolicy-facing read accessors, including the `ProposalNotFound` panic paths foundation §2.2 requires (`cap_of`/`action_of` "Panic ProposalNotFound if absent"). NOTE: `vote_scenario` re-initializes the contract on each call, so the approved and rejected scenarios are SEPARATE tests (they cannot share one `Env`):
  ```rust
  #[test]
  fn test_is_approved_reflects_status() {
      let (env, client, admin, usdc) = setup();
      let approved_id = vote_scenario(&env, &client, &admin, &usdc, 3, 0, 2_000);
      set_time(&env, 2_001);
      client.close(&approved_id);
      assert_eq!(client.is_approved(&approved_id), true);
  }

  #[test]
  fn test_is_approved_false_for_rejected() {
      let (env, client, admin, usdc) = setup();
      let id = vote_scenario(&env, &client, &admin, &usdc, 2, 0, 2_000); // <3 voters -> Rejected
      set_time(&env, 2_001);
      client.close(&id);
      assert_eq!(client.is_approved(&id), false);
  }

  #[test]
  fn test_cap_of_and_action_of_return_stored_values() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      // give the proposal a future deadline relative to default ledger time (0)
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000_000_000u64);
      assert_eq!(client.cap_of(&id), 15_000);
      assert_eq!(client.action_of(&id), spec);
  }

  #[test]
  fn test_cap_of_not_found_panics() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      assert_eq!(client.try_cap_of(&123u32), Err(Ok(GovError::ProposalNotFound)));
  }

  #[test]
  fn test_action_of_not_found_panics() {
      let (env, client, admin, usdc) = setup();
      init_default(&env, &client, &admin, &usdc);
      assert_eq!(client.try_action_of(&123u32), Err(Ok(GovError::ProposalNotFound)));
  }
  ```
- [ ] 9B.2 Run, confirm RED:
  ```bash
  cargo test -p gov-vault test_is_approved test_cap_of test_action_of 2>&1 | tail -20
  ```
  **Expected (RED):** `no method named 'is_approved'` / `no method named 'cap_of'` / `no method named 'try_cap_of'` / `no method named 'action_of'`. Build fails.
- [ ] 9B.3 **GREEN.** Add the three read accessors to `impl GovVault`:
  ```rust
  /// True iff status == Approved (read by AgentPolicy in M2). View; no auth.
  pub fn is_approved(env: Env, id: u32) -> bool {
      storage::get_proposal(&env, id).status == ProposalStatus::Approved
  }

  /// Approved-proposal spending cap (read by AgentPolicy). Panics ProposalNotFound if absent.
  pub fn cap_of(env: Env, id: u32) -> i128 {
      storage::get_proposal(&env, id).cap
  }

  /// The approved ActionSpec (read by AgentPolicy). Panics ProposalNotFound if absent.
  pub fn action_of(env: Env, id: u32) -> ActionSpec {
      storage::get_proposal(&env, id).action_spec
  }
  ```
  > `storage::get_proposal` already panics `GovError::ProposalNotFound` for an absent id (Task 4.3), so `cap_of`/`action_of` inherit the foundation §2.2 panic with no extra code.
- [ ] 9B.4 Run, confirm GREEN:
  ```bash
  cargo test -p gov-vault test_is_approved test_cap_of test_action_of 2>&1 | tail -15
  ```
  **Expected (GREEN):** `test_is_approved_reflects_status ... ok`, `test_is_approved_false_for_rejected ... ok`, `test_cap_of_and_action_of_return_stored_values ... ok`, `test_cap_of_not_found_panics ... ok`, `test_action_of_not_found_panics ... ok`. `5 passed`.
- [ ] 9B.5 **COMMIT:**
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'feat(gov-vault): is_approved/cap_of/action_of read accessors with ProposalNotFound negatives\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 10 — `mark_executed` single-shot replay guard

**Files:** Modify `contracts/gov-vault/src/lib.rs`. Tests in `contracts/gov-vault/src/test.rs`.

> **Author the Task 17 integration tests here too.** `mark_executed` is the LAST gov-vault entrypoint, so the end-to-end integration tests (`integration_vote_to_approve_flow`, `integration_no_quorum_blocks_execution` — see Task 17) drive the loop through `mark_executed`. Append those two integration tests in THIS step (10.1) alongside the two unit tests below, so they all share the genuine `no method named 'mark_executed'` red. Task 17 then re-runs and verifies them. (This is what makes Task 17 a real red→green and not a green-on-first-run.)

- [ ] 10.1 **RED.** Append the two `mark_executed` unit tests below AND the two integration tests from Task 17.1 (copy them verbatim from there). None of `mark_executed` exists yet, so all four fail to compile — a genuine red:
  ```rust
  #[test]
  fn test_mark_executed_single_shot() {
      let (env, client, admin, usdc) = setup();
      let id = vote_scenario(&env, &client, &admin, &usdc, 3, 0, 2_000);
      set_time(&env, 2_001);
      client.close(&id);
      assert_eq!(client.is_approved(&id), true);
      client.mark_executed(&id);
      let view = client.proposal(&id);
      assert_eq!(view.status, ProposalStatus::Executed);
      // second call must be rejected (single-shot)
      assert_eq!(client.try_mark_executed(&id), Err(Ok(GovError::AlreadyExecuted)));
  }

  #[test]
  fn test_mark_executed_requires_approved() {
      let (env, client, admin, usdc) = setup();
      // rejected proposal (low participation)
      let id = vote_scenario(&env, &client, &admin, &usdc, 2, 0, 2_000);
      set_time(&env, 2_001);
      client.close(&id);
      assert_eq!(client.is_approved(&id), false);
      assert_eq!(client.try_mark_executed(&id), Err(Ok(GovError::NotApproved)));
  }
  ```
- [ ] 10.2 Run, confirm RED (the two unit tests AND the two Task-17 integration tests all fail — `mark_executed` does not exist):
  ```bash
  cargo test -p gov-vault test_mark_executed integration_ 2>&1 | tail -20
  ```
  **Expected (RED):** `error[E0599]: no method named 'mark_executed' found for struct 'GovVaultClient'`. Build fails — a genuine red for `test_mark_executed_single_shot`, `test_mark_executed_requires_approved`, `integration_vote_to_approve_flow`, and `integration_no_quorum_blocks_execution`. Paste this output; it is also the red referenced by Task 17.1.1.
- [ ] 10.3 **GREEN.** Add `mark_executed` to `impl GovVault`:
  ```rust
  /// Single-shot replay guard. Requires status==Approved & not executed. Sets status -> Executed.
  /// M1: callable by anyone (NO auth). The foundation §2.2 auth tightening — `require_auth` on the
  /// configured executor (AgentPolicy address) stored at `DataKey::Executor` — is implemented in M2
  /// (Task M2-0c: `set_executor` + the `require_auth` gate + a non-executor-rejected negative test).
  /// M1 does NOT leave this open by oversight; M2 OWNS the gate (recorded handoff).
  pub fn mark_executed(env: Env, id: u32) {
      let mut rec = storage::get_proposal(&env, id);
      if rec.executed || rec.status == ProposalStatus::Executed {
          panic_with_error!(&env, GovError::AlreadyExecuted);
      }
      if rec.status != ProposalStatus::Approved {
          panic_with_error!(&env, GovError::NotApproved);
      }
      rec.executed = true;
      rec.status = ProposalStatus::Executed;
      storage::set_proposal(&env, id, &rec);
      crate::ProposalExecuted { id }.publish(&env);
  }
  ```
- [ ] 10.4 Add the `ProposalExecuted` event (foundation §2.2):
  ```rust
  #[contractevent]
  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct ProposalExecuted { #[topic] pub id: u32 }
  ```
- [ ] 10.5 Run, confirm GREEN (the two unit tests AND the two Task-17 integration tests now pass — one impl satisfied all four reds):
  ```bash
  cargo test -p gov-vault test_mark_executed integration_ 2>&1 | tail -12
  ```
  **Expected (GREEN):** `test_mark_executed_single_shot ... ok`, `test_mark_executed_requires_approved ... ok`, `integration_vote_to_approve_flow ... ok`, `integration_no_quorum_blocks_execution ... ok`. `4 passed`.
- [ ] 10.6 Run the WHOLE gov-vault suite to confirm nothing regressed:
  ```bash
  cargo test -p gov-vault 2>&1 | tail -8
  ```
  **Expected:** `test result: ok.` with all gov-vault tests passing (init x2, create x6, cast x5 + event x1, close x5 + event x2, read accessors x5, mark x2, integration x2, plus the `shadowkit-shared` test). No failures, no ignored.
- [ ] 10.7 **COMMIT** (mark_executed unit + integration loop is one TDD cycle):
  ```bash
  git add contracts/gov-vault && git commit -m "$(printf 'feat(gov-vault): mark_executed single-shot guard + end-to-end governance integration tests\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 7 — `swap-venue` trait crate (foundation §2.4)

### Task 11 — Create the `swap-venue` crate with the `SwapVenue` trait + `SwapVenueClient`

**Files:** Create `contracts/swap-venue/Cargo.toml`, `contracts/swap-venue/src/lib.rs`. Modify root `Cargo.toml` members.

- [ ] 11.1 Create `contracts/swap-venue/Cargo.toml`:
  ```toml
  [package]
  name = "swap-venue"
  version = "0.1.0"
  edition = "2021"
  publish = false

  [lib]
  crate-type = ["rlib"]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }
  ```
- [ ] 11.2 Create `contracts/swap-venue/src/lib.rs` (foundation §2.4 verbatim):
  ```rust
  #![no_std]
  use soroban_sdk::{contractclient, Address, Env};

  /// Common interface every venue (FallbackAMM, Soroswap adapter) satisfies.
  /// AgentPolicy (M2) only ever authorizes calls to `swap` on the configured venue address.
  #[contractclient(name = "SwapVenueClient")]
  pub trait SwapVenue {
      /// Swap exactly `amount_in` of `asset_in` for >= `min_out` of the other asset, sent `to`.
      /// Returns the actual amount out. Reverts if out < min_out (slippage guard).
      fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128;

      /// Current reserves (reserve_a, reserve_b) keyed by the pool's canonical asset ordering.
      fn reserves(env: Env) -> (i128, i128);
  }
  ```
- [ ] 11.3 Add `"contracts/swap-venue"` to root `Cargo.toml` `[workspace] members` (if not already added in Task 2.5).
- [ ] 11.4 Confirm it compiles (the trait + generated `SwapVenueClient`):
  ```bash
  cargo build -p swap-venue 2>&1 | tail -8
  ```
  **Expected:** `Finished`. `#[contractclient(name = "SwapVenueClient")]` generates the `SwapVenueClient` struct (verified pattern, ctx7 `/stellar/rs-soroban-sdk`: a `#[contractclient]` on a trait produces a typed client usable across contracts).
- [ ] 11.5 **COMMIT:**
  ```bash
  git add contracts/swap-venue Cargo.toml && git commit -m "$(printf 'feat(swap-venue): add venue-agnostic SwapVenue trait and SwapVenueClient\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 8 — `fallback-amm` crate

### Task 12 — Scaffold `fallback-amm` + `init` + `reserves`

**Files:** Create `contracts/fallback-amm/Cargo.toml`, `contracts/fallback-amm/src/lib.rs`, `contracts/fallback-amm/src/test.rs`. Modify root `Cargo.toml`.

- [ ] 12.1 Create `contracts/fallback-amm/Cargo.toml`:
  ```toml
  [package]
  name = "fallback-amm"
  version = "0.1.0"
  edition = "2021"
  publish = false

  [lib]
  crate-type = ["cdylib", "rlib"]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }
  swap-venue = { path = "../swap-venue" }

  [dev-dependencies]
  soroban-sdk = { workspace = true, features = ["testutils"] }
  ```
- [ ] 12.2 Create `contracts/fallback-amm/src/lib.rs` with `init`/`reserves` + `AmmError` (foundation §2.5). The SAC token interface is imported via `contractimport`-free `token::Client` from soroban-sdk's built-in token module:
  ```rust
  #![no_std]
  #[cfg(test)]
  mod test;

  use soroban_sdk::{
      contract, contracterror, contractevent, contractimpl, contracttype,
      token, Address, Env,
  };

  #[contracttype]
  #[derive(Clone)]
  pub enum AmmKey { AssetA, AssetB, ReserveA, ReserveB }

  #[contracterror]
  #[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
  #[repr(u32)]
  pub enum AmmError {
      NotInitialized        = 1,
      AlreadyInitialized    = 2,
      UnknownAsset          = 3,   // asset_in is neither asset_a nor asset_b
      SlippageExceeded      = 4,   // out < min_out
      InsufficientLiquidity = 5,
      ZeroAmount            = 6,
  }

  #[contractevent]
  #[derive(Clone, Debug, Eq, PartialEq)]
  pub struct Swapped { #[topic] pub asset_in: Address, pub amount_in: i128, pub amount_out: i128 }

  #[contract]
  pub struct FallbackAMM;

  #[contractimpl]
  impl FallbackAMM {
      /// Set the two pool assets (e.g. USDC SAC, XLM SAC). Once only.
      pub fn init(env: Env, asset_a: Address, asset_b: Address) {
          if env.storage().instance().has(&AmmKey::AssetA) {
              soroban_sdk::panic_with_error!(&env, AmmError::AlreadyInitialized);
          }
          env.storage().instance().set(&AmmKey::AssetA, &asset_a);
          env.storage().instance().set(&AmmKey::AssetB, &asset_b);
          env.storage().instance().set(&AmmKey::ReserveA, &0i128);
          env.storage().instance().set(&AmmKey::ReserveB, &0i128);
      }

      /// (reserve_a, reserve_b). Implements SwapVenue::reserves.
      pub fn reserves(env: Env) -> (i128, i128) {
          let ra: i128 = env.storage().instance().get(&AmmKey::ReserveA).unwrap_or(0);
          let rb: i128 = env.storage().instance().get(&AmmKey::ReserveB).unwrap_or(0);
          (ra, rb)
      }
  }
  ```
  > `token` is soroban-sdk's built-in token module: `token::Client::new(&env, &asset_addr)` (read/transfer) and `token::StellarAssetClient::new(&env, &asset_addr)` (admin mint). Verified via ctx7 `/stellar/rs-soroban-sdk` 2026-06-02 — SAC tokens in tests are created with `env.register_stellar_asset_contract_v2(admin)` returning a `StellarAssetContract` whose `.address()` feeds these clients.
- [ ] 12.3 Create `contracts/fallback-amm/src/test.rs`:
  ```rust
  #![cfg(test)]
  ```
- [ ] 12.4 Add `"contracts/fallback-amm"` to root `Cargo.toml` `[workspace] members` (if not yet present).
- [ ] 12.5 Compile:
  ```bash
  cargo build -p fallback-amm 2>&1 | tail -8
  ```
  **Expected:** `Finished`.
- [ ] 12.6 **COMMIT:**
  ```bash
  git add contracts/fallback-amm Cargo.toml && git commit -m "$(printf 'build(amm): scaffold FallbackAMM with init, reserves, AmmError\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 13 — `add_liquidity` pulls tokens and updates reserves

**Files:** Modify `contracts/fallback-amm/src/lib.rs`. Tests in `contracts/fallback-amm/src/test.rs`.

- [ ] 13.1 **RED.** Replace `contracts/fallback-amm/src/test.rs` with a SAC-backed harness + `add_liquidity` test:
  ```rust
  #![cfg(test)]
  use crate::{FallbackAMM, FallbackAMMClient, AmmError};
  use soroban_sdk::{testutils::Address as _, token, Address, Env};

  struct Fixture<'a> {
      env: Env,
      amm: FallbackAMMClient<'a>,
      asset_a: Address,
      asset_b: Address,
      admin: Address,
  }

  /// Create a SAC token, return (address, admin StellarAssetClient feeds via address).
  fn make_token(env: &Env, admin: &Address) -> Address {
      // register_stellar_asset_contract_v2 returns a StellarAssetContract; .address() is the SAC id.
      // Verified ctx7 /stellar/rs-soroban-sdk testutils 2026-06-02.
      env.register_stellar_asset_contract_v2(admin.clone()).address()
  }

  fn setup() -> Fixture<'static> {
      let env = Env::default();
      env.mock_all_auths();
      let admin = Address::generate(&env);
      let asset_a = make_token(&env, &admin);
      let asset_b = make_token(&env, &admin);
      let amm_id = env.register(FallbackAMM, ());
      let amm = FallbackAMMClient::new(&env, &amm_id);
      amm.init(&asset_a, &asset_b);
      Fixture { env, amm, asset_a, asset_b, admin }
  }

  /// Mint `amount` of `asset` to `to` using the SAC admin client.
  fn mint(env: &Env, asset: &Address, to: &Address, amount: i128) {
      token::StellarAssetClient::new(env, asset).mint(to, &amount);
  }

  #[test]
  fn test_add_liquidity_updates_reserves() {
      let f = setup();
      let lp = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &lp, 1_000_000);
      mint(&f.env, &f.asset_b, &lp, 1_000_000);
      f.amm.add_liquidity(&lp, &100_000i128, &50_000i128);
      let (ra, rb) = f.amm.reserves();
      assert_eq!(ra, 100_000);
      assert_eq!(rb, 50_000);
      // tokens actually moved from lp into the amm
      let amm_addr = f.amm.address.clone();
      assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&amm_addr), 100_000);
      assert_eq!(token::Client::new(&f.env, &f.asset_b).balance(&amm_addr), 50_000);
      assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&lp), 900_000);
  }
  ```
- [ ] 13.2 Run, confirm RED:
  ```bash
  cargo test -p fallback-amm test_add_liquidity_updates_reserves 2>&1 | tail -18
  ```
  **Expected (RED):** `no method named 'add_liquidity'` on the client.
- [ ] 13.3 **GREEN.** Add `add_liquidity` to `impl FallbackAMM`:
  ```rust
  /// Deposit liquidity; `from` must auth. Pulls amount_a/amount_b into the pool, updates reserves.
  pub fn add_liquidity(env: Env, from: Address, amount_a: i128, amount_b: i128) {
      from.require_auth();
      if amount_a <= 0 || amount_b <= 0 {
          soroban_sdk::panic_with_error!(&env, AmmError::ZeroAmount);
      }
      let asset_a: Address = env.storage().instance().get(&AmmKey::AssetA)
          .unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, AmmError::NotInitialized));
      let asset_b: Address = env.storage().instance().get(&AmmKey::AssetB).unwrap();
      let this = env.current_contract_address();
      token::Client::new(&env, &asset_a).transfer(&from, &this, &amount_a);
      token::Client::new(&env, &asset_b).transfer(&from, &this, &amount_b);
      let ra: i128 = env.storage().instance().get(&AmmKey::ReserveA).unwrap_or(0);
      let rb: i128 = env.storage().instance().get(&AmmKey::ReserveB).unwrap_or(0);
      env.storage().instance().set(&AmmKey::ReserveA, &(ra + amount_a));
      env.storage().instance().set(&AmmKey::ReserveB, &(rb + amount_b));
  }
  ```
- [ ] 13.4 Run, confirm GREEN:
  ```bash
  cargo test -p fallback-amm test_add_liquidity_updates_reserves 2>&1 | tail -12
  ```
  **Expected (GREEN):** `test test::test_add_liquidity_updates_reserves ... ok`, `1 passed`.
- [ ] 13.5 **COMMIT:**
  ```bash
  git add contracts/fallback-amm && git commit -m "$(printf 'feat(amm): add_liquidity pulls tokens and updates reserves\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 14 — `swap`: ALL behaviors written RED first (constant-product math, reverse, unknown-asset, slippage revert, zero-amount revert), then ONE implementation

> **TDD note (fixes the prior plan's regression-lock anti-pattern):** the earlier draft put the slippage + zero-amount revert tests in a separate Task 15 that admitted those guards "already exist (Task 14.3), so these tests lock that behavior" — i.e. a green-on-first-run with no prior red, which foundation §7 rule 4 forbids. This task writes ALL FIVE `swap` behavior tests (math, reverse direction, unknown-asset, slippage revert, zero-amount revert) BEFORE `swap` exists, so each gets a genuine compile-level red, then a single minimal implementation turns them all green. There is no separate "lock" task.

**Files:** Modify `contracts/fallback-amm/src/lib.rs`. Tests in `contracts/fallback-amm/src/test.rs`.

- [ ] 14.1 **RED.** Append all five `swap` tests (none of `swap` exists yet ⇒ whole module fails to compile ⇒ real red). The math test carries a hand-computed expected output:
  ```rust
  #[test]
  fn test_swap_constant_product_math() {
      let f = setup();
      let lp = Address::generate(&f.env);
      // pool: A=1_000_000, B=1_000_000
      mint(&f.env, &f.asset_a, &lp, 2_000_000);
      mint(&f.env, &f.asset_b, &lp, 2_000_000);
      f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);

      let trader = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &trader, 100_000);
      // swap 10_000 A in. fee 0.3% => amount_in_with_fee = 10_000 * 997 / 1000 = 9_970
      // out = (rb * in_fee) / (ra + in_fee) = (1_000_000 * 9_970) / (1_000_000 + 9_970)
      //     = 9_970_000_000 / 1_009_970 = 9_871  (integer floor)
      let out = f.amm.swap(&f.asset_a, &10_000i128, &1i128, &trader);
      assert_eq!(out, 9_871);
      // reserves: A up by 10_000, B down by out
      let (ra, rb) = f.amm.reserves();
      assert_eq!(ra, 1_010_000);
      assert_eq!(rb, 1_000_000 - 9_871);
      // trader received `out` of B
      assert_eq!(token::Client::new(&f.env, &f.asset_b).balance(&trader), 9_871);
      // trader spent 10_000 of A
      assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&trader), 90_000);
  }

  #[test]
  fn test_swap_reverse_direction() {
      let f = setup();
      let lp = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &lp, 1_000_000);
      mint(&f.env, &f.asset_b, &lp, 1_000_000);
      f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
      let trader = Address::generate(&f.env);
      mint(&f.env, &f.asset_b, &trader, 100_000);
      // swap B in -> get A out; symmetric math, same numbers
      let out = f.amm.swap(&f.asset_b, &10_000i128, &1i128, &trader);
      assert_eq!(out, 9_871);
      assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&trader), 9_871);
  }

  #[test]
  fn test_swap_unknown_asset_rejected() {
      let f = setup();
      let stranger_asset = make_token(&f.env, &f.admin);
      let trader = Address::generate(&f.env);
      let res = f.amm.try_swap(&stranger_asset, &10_000i128, &1i128, &trader);
      assert_eq!(res, Err(Ok(AmmError::UnknownAsset)));
  }

  // slippage guard: demand a min_out above the achievable output -> SlippageExceeded, and the
  // revert leaves reserves AND balances untouched (no partial state mutation).
  #[test]
  fn test_swap_slippage_revert() {
      let f = setup();
      let lp = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &lp, 1_000_000);
      mint(&f.env, &f.asset_b, &lp, 1_000_000);
      f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
      let trader = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &trader, 100_000);
      // demand min_out far above the achievable 9_871 -> SlippageExceeded
      let res = f.amm.try_swap(&f.asset_a, &10_000i128, &10_000i128, &trader);
      assert_eq!(res, Err(Ok(AmmError::SlippageExceeded)));
      // reserves unchanged after revert
      let (ra, rb) = f.amm.reserves();
      assert_eq!(ra, 1_000_000);
      assert_eq!(rb, 1_000_000);
      // trader balance unchanged (no transfer happened)
      assert_eq!(token::Client::new(&f.env, &f.asset_a).balance(&trader), 100_000);
  }

  // zero (or negative) amount_in -> ZeroAmount, before any reserve read/transfer.
  #[test]
  fn test_swap_zero_amount_revert() {
      let f = setup();
      let lp = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &lp, 1_000_000);
      mint(&f.env, &f.asset_b, &lp, 1_000_000);
      f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
      let trader = Address::generate(&f.env);
      let res = f.amm.try_swap(&f.asset_a, &0i128, &1i128, &trader);
      assert_eq!(res, Err(Ok(AmmError::ZeroAmount)));
  }
  ```
- [ ] 14.2 Run, confirm RED (all five swap tests fail — `swap` does not exist yet):
  ```bash
  cargo test -p fallback-amm test_swap_constant_product_math test_swap_reverse_direction test_swap_unknown_asset_rejected test_swap_slippage_revert test_swap_zero_amount_revert 2>&1 | tail -18
  ```
  **Expected (RED):** compile error `no method named 'swap' found for struct 'FallbackAMMClient'` / `no method named 'try_swap'`. Build fails — a genuine red for all five tests.
- [ ] 14.3 **GREEN.** Add `swap` to `impl FallbackAMM` with the verified constant-product formula:
  ```rust
  /// Constant-product swap (x*y=k) with 0.3% fee. Pulls `amount_in` from caller, pushes out to `to`.
  /// Reverts SlippageExceeded if computed out < min_out. Implements SwapVenue::swap.
  /// Formula (Uniswap v2): in_fee = amount_in*997/1000; out = reserve_out*in_fee/(reserve_in+in_fee).
  pub fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128 {
      to.require_auth();
      if amount_in <= 0 {
          soroban_sdk::panic_with_error!(&env, AmmError::ZeroAmount);
      }
      let asset_a: Address = env.storage().instance().get(&AmmKey::AssetA)
          .unwrap_or_else(|| soroban_sdk::panic_with_error!(&env, AmmError::NotInitialized));
      let asset_b: Address = env.storage().instance().get(&AmmKey::AssetB).unwrap();
      let ra: i128 = env.storage().instance().get(&AmmKey::ReserveA).unwrap_or(0);
      let rb: i128 = env.storage().instance().get(&AmmKey::ReserveB).unwrap_or(0);

      // Determine in/out reserves by which asset is coming in.
      let (reserve_in, reserve_out, is_a_in) = if asset_in == asset_a {
          (ra, rb, true)
      } else if asset_in == asset_b {
          (rb, ra, false)
      } else {
          soroban_sdk::panic_with_error!(&env, AmmError::UnknownAsset);
      };
      if reserve_in <= 0 || reserve_out <= 0 {
          soroban_sdk::panic_with_error!(&env, AmmError::InsufficientLiquidity);
      }

      let in_fee = amount_in * 997 / 1000;
      let amount_out = reserve_out * in_fee / (reserve_in + in_fee);
      if amount_out <= 0 {
          soroban_sdk::panic_with_error!(&env, AmmError::InsufficientLiquidity);
      }
      if amount_out < min_out {
          soroban_sdk::panic_with_error!(&env, AmmError::SlippageExceeded);
      }

      let this = env.current_contract_address();
      // pull asset_in from caller; push asset_out to `to`
      let asset_out = if is_a_in { asset_b.clone() } else { asset_a.clone() };
      token::Client::new(&env, &asset_in).transfer(&to, &this, &amount_in);
      token::Client::new(&env, &asset_out).transfer(&this, &to, &amount_out);

      // update reserves
      if is_a_in {
          env.storage().instance().set(&AmmKey::ReserveA, &(ra + amount_in));
          env.storage().instance().set(&AmmKey::ReserveB, &(rb - amount_out));
      } else {
          env.storage().instance().set(&AmmKey::ReserveB, &(rb + amount_in));
          env.storage().instance().set(&AmmKey::ReserveA, &(ra - amount_out));
      }
      Swapped { asset_in, amount_in, amount_out }.publish(&env);
      amount_out
  }
  ```
- [ ] 14.4 Run ALL FIVE `swap` tests, confirm they turn GREEN together (one minimal impl satisfied every prior red):
  ```bash
  cargo test -p fallback-amm test_swap_constant_product_math test_swap_reverse_direction test_swap_unknown_asset_rejected test_swap_slippage_revert test_swap_zero_amount_revert 2>&1 | tail -14
  ```
  **Expected (GREEN):** all five `... ok`, `test result: ok. 5 passed`. If `test_swap_constant_product_math` fails with `assertion left: 9871 right: <other>`, re-derive: `1_000_000 * 9_970 = 9_970_000_000`; `1_000_000 + 9_970 = 1_009_970`; `9_970_000_000 / 1_009_970 = 9871` (floor). The expected value is correct for this exact reserve/amount.
- [ ] 14.5 **COMMIT** (the whole red→green `swap` cycle — math + reverse + unknown-asset + slippage + zero-amount — is one TDD cycle):
  ```bash
  git add contracts/fallback-amm && git commit -m "$(printf 'feat(amm): constant-product swap with 0.3%% fee, asset routing, slippage and zero-amount guards\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 15 — Full FallbackAMM suite green + no-skipped audit

**Files:** none (verification only).

- [ ] 15.1 Run the full AMM suite to confirm `add_liquidity` + all five `swap` behaviors pass together with nothing ignored:
  ```bash
  cargo test -p fallback-amm 2>&1 | tail -10
  ```
  **Expected:** `test result: ok.` with every AMM test passing (`test_add_liquidity_updates_reserves`, `test_swap_constant_product_math`, `test_swap_reverse_direction`, `test_swap_unknown_asset_rejected`, `test_swap_slippage_revert`, `test_swap_zero_amount_revert`), `0 ignored`.
- [ ] 15.2 Confirm there are no skipped/ignored AMM tests:
  ```bash
  grep -nE '#\[ignore\]' contracts/fallback-amm/src/test.rs || echo "no #[ignore] in amm tests"
  ```
  **Expected:** `no #[ignore] in amm tests`.
- [ ] 15.3 No commit (verification only; no source change).

---

## Phase 9 — FallbackAMM IS the SwapVenue fallback (venue-agnostic proof)

### Task 16 — Prove `FallbackAMM` satisfies `SwapVenue` via the generated `SwapVenueClient`

**Files:** Modify `contracts/fallback-amm/src/test.rs`. `swap-venue` is already a dependency of `fallback-amm` (Task 12.1, per foundation §1), so `swap_venue::SwapVenueClient` is in scope. This is the FALLBACK test required by the charter: the `SwapVenue` trait is venue-agnostic and FallbackAMM is the fallback venue; we test FallbackAMM **through the trait's client**, not its concrete client.

> **How this task keeps a genuine red (no green-on-first-run):** the new behavior under test is cross-contract dispatch through the *generated trait client* `SwapVenueClient` — `venue.swap(...)` / `venue.reserves(...)`. These dispatch to FallbackAMM's `swap`/`reserves` entrypoints. To get a real, paste-able red, author the two tests below as part of the **Task 14.1 RED batch** — BEFORE `swap` is implemented (Task 14.3). At that point `venue.swap(...)` cannot dispatch (FallbackAMM exports no `swap`), so the suite fails to compile/link (`no method named 'swap'` is reported for both the concrete and the trait-client call sites). When Task 14.3 adds `swap`, these venue-agnostic tests go green together with the concrete-client swap tests. This is a legitimate pre-implementation red for the venue-agnostic dispatch path — not "the absence of a test". (`reserves` already exists from Task 12, so the `reserves`-only assertions would compile, but the `swap` assertions provide the red.)

- [ ] 16.1 Confirm the venue-agnostic tests below were authored in the Task 14.1 batch (so they shared the `no method named 'swap'` red). If you did NOT author them then, you cannot retro-fit a red here without faking one — instead, you must already have a paste of the Task 14.2 red output that INCLUDES `test_fallback_amm_is_a_swap_venue` / `test_swap_venue_slippage_through_trait` failing to resolve `swap`. The tests are:
  ```rust
  use swap_venue::SwapVenueClient;

  #[test]
  fn test_fallback_amm_is_a_swap_venue() {
      let f = setup();
      let lp = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &lp, 1_000_000);
      mint(&f.env, &f.asset_b, &lp, 1_000_000);
      f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);

      // Treat the SAME contract id purely through the venue-agnostic interface.
      let venue = SwapVenueClient::new(&f.env, &f.amm.address);
      let (ra, rb) = venue.reserves();
      assert_eq!((ra, rb), (1_000_000, 1_000_000));

      let trader = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &trader, 100_000);
      let out = venue.swap(&f.asset_a, &10_000i128, &1i128, &trader);
      assert_eq!(out, 9_871); // identical behavior whether called via concrete or trait client
      // reserves moved exactly as the concrete-client swap test asserts
      let (ra2, rb2) = venue.reserves();
      assert_eq!(ra2, 1_010_000);
      assert_eq!(rb2, 1_000_000 - 9_871);
  }

  #[test]
  fn test_swap_venue_slippage_through_trait() {
      let f = setup();
      let lp = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &lp, 1_000_000);
      mint(&f.env, &f.asset_b, &lp, 1_000_000);
      f.amm.add_liquidity(&lp, &1_000_000i128, &1_000_000i128);
      let venue = SwapVenueClient::new(&f.env, &f.amm.address);
      let trader = Address::generate(&f.env);
      mint(&f.env, &f.asset_a, &trader, 100_000);
      // slippage guard still enforced when called through the trait client
      let res = venue.try_swap(&f.asset_a, &10_000i128, &10_000i128, &trader);
      assert_eq!(res, Err(Ok(soroban_sdk::Error::from_contract_error(AmmError::SlippageExceeded as u32))));
  }
  ```
  > `SwapVenueClient::try_swap` returns `Result<Result<i128,_>, Result<soroban_sdk::Error,_>>` because the trait client does not know FallbackAMM's concrete error enum; we compare against `soroban_sdk::Error::from_contract_error(AmmError::SlippageExceeded as u32)` (code 4). This proves the contract error propagates through the venue-agnostic boundary. Verified pattern: ctx7 `/stellar/rs-soroban-sdk` — `try_` client methods surface `soroban_sdk::Error::from_contract_error(code)` for cross-contract error decoding.
- [ ] 16.2.1 **RED (the paste).** When these tests were run as part of the Task 14.2 RED batch (before `swap` existed), the output included the venue-agnostic call sites failing:
  ```
  error[E0599]: no method named `swap` found for struct `SwapVenueClient` in the current scope
    --> contracts/fallback-amm/src/test.rs
       |  let out = venue.swap(&f.asset_a, &10_000i128, &1i128, &trader);
       |                  ^^^^ method not found in `SwapVenueClient<'_>`
  ```
  (Plus the same for the concrete `f.amm.swap(...)` calls.) That is this task's genuine red; record it in the Task 14 RED paste.
- [ ] 16.3 Run, confirm GREEN (now that Task 14.3 implemented `swap`, the venue-agnostic dispatch resolves):
  ```bash
  cargo test -p fallback-amm test_fallback_amm_is_a_swap_venue test_swap_venue_slippage_through_trait 2>&1 | tail -16
  ```
  **Expected (GREEN):** both tests `... ok`, `2 passed`. If the error-comparison line in `test_swap_venue_slippage_through_trait` mismatches, print the actual `Err(...)` and adjust to `Err(Ok(...))` vs `Err(Err(...))` based on the real shape (the `try_` client returns `Err(Ok(error))` when the contract returned a recognized error code). Do NOT relax the assertion to make it pass — fix it to match the real, observed error shape.
- [ ] 16.4 Run the full AMM suite again to confirm no regression:
  ```bash
  cargo test -p fallback-amm 2>&1 | tail -8
  ```
  **Expected:** `test result: ok.` everything green, including `test_fallback_amm_is_a_swap_venue` and `test_swap_venue_slippage_through_trait`.
- [ ] 16.5 **No separate commit here.** The venue-agnostic tests were authored in the Task 14.1 batch and committed in Task 14.5 (they turned green with the `swap` impl). This task is the venue-agnostic VERIFICATION gate. If you authored them separately (not recommended), commit them now with:
  ```bash
  git add contracts/fallback-amm && git commit -m "$(printf 'test(amm): prove FallbackAMM satisfies venue-agnostic SwapVenue (fallback venue)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 10 — Cross-contract integration (vote → approve, on-chain)

### Task 17 — Integration test: full vote→quorum→approved with real on-chain state, then mark_executed

**Files:** Test only — append to `contracts/gov-vault/src/test.rs`. This is the PRIMARY-path integration test required by the charter (real on-chain state, no fallback).

> **How this task keeps a genuine red (no green-on-first-run):** both integration tests below drive the loop all the way to `client.mark_executed(&id)` / `client.try_mark_executed(&id)`. To get a real, paste-able red, author these two tests as part of the **Task 10.1 RED batch** — BEFORE `mark_executed` is implemented (Task 10.3). At that point the suite fails to compile with `no method named 'mark_executed' found for struct 'GovVaultClient'`, which is the genuine pre-implementation red for the end-to-end flow's final step. When Task 10.3 adds `mark_executed`, these integration tests go green together with Task 10's unit tests. Task 17 (here) is where you RE-RUN and VERIFY the full integrated loop and the whole-workspace gate. Do NOT add these tests after Task 10 is already green (that would be a green-on-first-run); add them in the Task 10.1 batch and only verify them here.

- [ ] 17.1 Confirm the two integration tests below were authored in the Task 10.1 RED batch (so they shared the `no method named 'mark_executed'` red). The tests are:
  ```rust
  #[test]
  fn integration_vote_to_approve_flow() {
      let (env, client, admin, usdc) = setup();
      // snapshot of 3 eligible voters with distinct weights
      let v_yes_a = Address::generate(&env);
      let v_yes_b = Address::generate(&env);
      let v_no    = Address::generate(&env);
      let w = weights(&env, &[
          (v_yes_a.clone(), 30),
          (v_yes_b.clone(), 25),
          (v_no.clone(), 40),
      ]);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);

      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000u64);
      assert_eq!(client.proposal(&id).status, ProposalStatus::Open);

      // votes: yes=30+25=55, no=40 ; 3 voters
      client.cast_vote(&id, &v_yes_a, &1u32);
      client.cast_vote(&id, &v_yes_b, &1u32);
      client.cast_vote(&id, &v_no,    &0u32);
      assert_eq!(client.votes_cast(&id), 3);
      // NO tally exposed before close (privacy invariant, even in plaintext M1)
      assert_eq!(client.proposal(&id).weighted_yes, None);

      // close after deadline
      set_time(&env, 2_001);
      client.close(&id);

      // real on-chain state: approved, weighted tally set
      let view = client.proposal(&id);
      assert_eq!(view.status, ProposalStatus::Approved);
      assert_eq!(view.weighted_yes, Some(55));
      assert_eq!(view.weighted_no, Some(40));
      assert_eq!(client.is_approved(&id), true);
      assert_eq!(client.cap_of(&id), 15_000);
      assert_eq!(client.action_of(&id), spec);

      // execute single-shot
      client.mark_executed(&id);
      assert_eq!(client.proposal(&id).status, ProposalStatus::Executed);
      assert_eq!(client.try_mark_executed(&id), Err(Ok(GovError::AlreadyExecuted)));
  }

  #[test]
  fn integration_no_quorum_blocks_execution() {
      let (env, client, admin, usdc) = setup();
      // only 2 voters -> participation < 3 -> Rejected -> cannot execute
      let a = Address::generate(&env);
      let b = Address::generate(&env);
      let w = weights(&env, &[(a.clone(), 10), (b.clone(), 10)]);
      let cfg = QuorumCfg { min_voters: 3, yes_must_exceed_no: true };
      env.mock_all_auths();
      client.init(&admin, &usdc, &cfg, &w);
      set_time(&env, 1_000);
      let spec = sample_spec(&env);
      let id = client.create_proposal(&spec, &15_000i128, &2_000u64);
      client.cast_vote(&id, &a, &1u32);
      client.cast_vote(&id, &b, &1u32);
      set_time(&env, 2_001);
      client.close(&id);
      assert_eq!(client.is_approved(&id), false);
      // execution blocked on-chain
      assert_eq!(client.try_mark_executed(&id), Err(Ok(GovError::NotApproved)));
  }
  ```
- [ ] 17.1.1 **RED (the paste).** When these were run as part of the Task 10.2 RED batch (before `mark_executed` existed), the output included:
  ```
  error[E0599]: no method named `mark_executed` found for struct `GovVaultClient` in the current scope
    --> contracts/gov-vault/src/test.rs
       |  client.mark_executed(&id);
       |         ^^^^^^^^^^^^^ method not found in `GovVaultClient<'_>`
  ```
  That is this task's genuine red; record it in the Task 10 RED paste.
- [ ] 17.2 Run, confirm GREEN (now that Task 10.3 implemented `mark_executed`, the full loop resolves):
  ```bash
  cargo test -p gov-vault integration_ 2>&1 | tail -12
  ```
  **Expected (GREEN):** `integration_vote_to_approve_flow ... ok`, `integration_no_quorum_blocks_execution ... ok`. `2 passed`.
- [ ] 17.3 Run the entire Rust workspace to confirm everything is green together:
  ```bash
  cargo test --workspace 2>&1 | tail -20
  ```
  **Expected:** `test result: ok.` for `shadowkit-shared`, `gov-vault`, `fallback-amm` (swap-venue has no tests of its own — that's fine). Zero failures, zero ignored.
- [ ] 17.4 **No commit here.** The integration tests were authored and committed in Task 10.7 (alongside `mark_executed`), so this task is a pure verification gate (re-run + confirm the integrated loop and full workspace are green). If the workspace is not green, STOP and fix the failing crate before continuing — do not weaken assertions.

---

## Phase 11 — `@shadowkit/shared` TS types

### Task 18 — Add `ProposalView`/`ActionSpec`/`ProposalStatus` TS types (foundation §3.1)

**Files:** Modify `packages/shared/src/types.ts`, `packages/shared/src/index.ts`. Create `packages/shared/vitest.config.ts` (only if Task 0.6 found none) and a `"test"` script in `packages/shared/package.json`. Test path: `packages/shared/src/types.test.ts` (new).

- [ ] 18.0 **Ensure `packages/shared` has its OWN node-environment vitest config** (so its tests never inherit web's jsdom config — `packages/shared` is framework-free). Using the Task 0.6 finding:
  - If Task 0.6 reported a root `vitest.workspace.ts` that already includes `packages/shared`, you may rely on it AND still add an explicit per-package config for deterministic isolated runs.
  - If Task 0.6 found NO `packages/shared/vitest.config.ts`, create it:
    ```typescript
    // packages/shared/vitest.config.ts
    import { defineConfig } from "vitest/config";

    export default defineConfig({
      test: {
        environment: "node",          // framework-free types/helpers; no DOM needed
        include: ["src/**/*.test.ts"],
      },
    });
    ```
  - Add a `"test"` script to `packages/shared/package.json` `"scripts"` if absent:
    ```json
    "test": "vitest run"
    ```
  > Vitest is resolvable here because it is a root devDependency of the npm workspace (foundation §6 pins `vitest 4.1.8`; M0 installs it). If `npx vitest` cannot find vitest from `packages/shared`, run it from the repo root pointing at the package (see 18.2). Verify the vitest config API with `npx ctx7@latest library "vitest" "defineConfig test environment node include"` then `npx ctx7@latest docs "<id>" "vitest config environment node include per-package"` before relying on it (foundation §6 rule).
- [ ] 18.1 **RED.** Create `packages/shared/src/types.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import type { ProposalView, ActionSpec, ProposalStatus } from "./types";
  import { isApproved } from "./types";

  describe("@shadowkit/shared types", () => {
    it("constructs a ProposalView and helper reads status", () => {
      const spec: ActionSpec = {
        kind: "swap",
        assetIn: "CUSDC",
        assetOut: "CXLM",
        amount: "15000",
        minOut: "14000",
      };
      const view: ProposalView = {
        id: 0,
        actionSpec: spec,
        cap: "15000",
        deadline: 2_000_000_000,
        votesCast: 3,
        status: "Approved" as ProposalStatus,
        weightedYes: "55",
        weightedNo: "40",
      };
      expect(isApproved(view)).toBe(true);
      expect(view.weightedYes).toBe("55");
    });

    it("treats open proposals as not approved and tally null", () => {
      const open: ProposalView = {
        id: 1,
        actionSpec: { kind: "swap", assetIn: "A", assetOut: "B", amount: "1", minOut: "1" },
        cap: "1",
        deadline: 1,
        votesCast: 0,
        status: "Open",
        weightedYes: null,
        weightedNo: null,
      };
      expect(isApproved(open)).toBe(false);
      expect(open.weightedYes).toBeNull();
    });
  });
  ```
- [ ] 18.2 Run, confirm RED. Run from the `packages/shared` directory so its own `vitest.config.ts` (node env, created in 18.0) is used — NOT web's jsdom config:
  ```bash
  cd /home/batuhan4/github/shadowKit/packages/shared && npx vitest run 2>&1 | tail -20
  ```
  **Expected (RED):** failure resolving `./types` exports `ProposalView`/`ActionSpec`/`isApproved` (module has no such export), or a transform error because the types/helper don't exist.
- [ ] 18.3 **GREEN.** Append to `packages/shared/src/types.ts` the BINDING types from foundation §3.1 plus the tiny helper used in the test:
  ```typescript
  export type ProposalStatus = "Open" | "Tallying" | "Approved" | "Rejected" | "Executed";

  export interface ActionSpec {
    kind: "swap";
    assetIn: string;   // contract/SAC address (C... strkey)
    assetOut: string;
    amount: string;    // i128 as decimal string
    minOut: string;    // i128 as decimal string
  }

  export interface ProposalView {
    id: number;
    actionSpec: ActionSpec;
    cap: string;       // i128 decimal string
    deadline: number;  // unix seconds
    votesCast: number;
    status: ProposalStatus;
    weightedYes: string | null; // null until close
    weightedNo: string | null;
  }

  /** Convenience: a proposal is approved iff its status is exactly "Approved". */
  export function isApproved(p: ProposalView): boolean {
    return p.status === "Approved";
  }
  ```
  > Do NOT remove any types M0 already placed here. If `types.ts` does not exist, create it with the block above. These types are foundation §3.1 verbatim (camelCase, i128 as `string`).
- [ ] 18.4 Re-export from `packages/shared/src/index.ts` (append, or create):
  ```typescript
  export * from "./types";
  ```
- [ ] 18.5 Run, confirm GREEN (same per-package config as 18.2):
  ```bash
  cd /home/batuhan4/github/shadowKit/packages/shared && npx vitest run 2>&1 | tail -12
  ```
  **Expected (GREEN):** `2 passed`.
- [ ] 18.6 **COMMIT** (include the new vitest config / test script if you created them in 18.0):
  ```bash
  git add packages/shared && git commit -m "$(printf 'feat(shared): add ProposalView, ActionSpec, ProposalStatus TS types + node vitest config\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 12 — Front-end test harness

### Task 19 — Configure Vitest (jsdom) + Testing Library in `web/`

**Files:** Modify `web/package.json`, `web/vitest.config.ts`; create `web/vitest.setup.ts`.

- [ ] 19.1 Add dev deps. Run (pinned versions are foundation §6; testing-library deps verified on npm 2026-06-02):
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npm install --save-dev --save-exact vitest@4.1.8 jsdom@latest @testing-library/react@latest @testing-library/user-event@latest @testing-library/jest-dom@latest react@latest react-dom@latest 2>&1 | tail -8
  ```
  **Expected:** install completes; `web/package.json` `devDependencies` now lists all of the above. (React is needed because the components are React islands.)
  > **API VERIFICATION (foundation §6 binding rule):** before this task, re-confirm the Testing Library render/query API with `npx ctx7@latest library "testing-library react" "render screen fireEvent userEvent vitest jsdom"` then `npx ctx7@latest docs "<id>" "render fireEvent click queryByText not in document"`. The verified surface (2026-06-02, ctx7 `/testing-library/testing-library-docs`): `import { render, screen, fireEvent, waitFor } from "@testing-library/react"`, `import userEvent from "@testing-library/user-event"`, queries `getByText/queryByText/getByRole/findByText`, `userEvent.setup()` + `await user.click(...)`.
- [ ] 19.2 Create `web/vitest.setup.ts`:
  ```typescript
  import "@testing-library/jest-dom/vitest";
  ```
- [ ] 19.3 Create/replace `web/vitest.config.ts` (jsdom + setup + React via the vite-react/astro plugin). Astro's vite already handles JSX; for isolated component tests we configure the React plugin directly:
  ```typescript
  import { defineConfig } from "vitest/config";
  import react from "@vitejs/plugin-react";

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  });
  ```
  Install the react vite plugin used above:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npm install --save-dev --save-exact @vitejs/plugin-react@latest 2>&1 | tail -4
  ```
- [ ] 19.4 Add a `test` script to `web/package.json` `"scripts"`:
  ```json
  "test": "vitest run"
  ```
- [ ] 19.5 Smoke-test the harness with a trivial passing test to prove the config works, then delete it. Create `web/src/components/_harness.test.tsx`:
  ```tsx
  import { render, screen } from "@testing-library/react";
  import { describe, it, expect } from "vitest";

  function Hello() { return <div>harness-ok</div>; }

  describe("vitest+jsdom harness", () => {
    it("renders a React component", () => {
      render(<Hello />);
      expect(screen.getByText("harness-ok")).toBeInTheDocument();
    });
  });
  ```
  Run:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/_harness.test.tsx 2>&1 | tail -12
  ```
  **Expected:** `1 passed`. Then delete the harness file:
  ```bash
  rm /home/batuhan4/github/shadowKit/web/src/components/_harness.test.tsx
  ```
- [ ] 19.6 **COMMIT:**
  ```bash
  git add web/package.json web/package-lock.json web/vitest.config.ts web/vitest.setup.ts 2>/dev/null; git add web; git commit -m "$(printf 'build(web): configure vitest jsdom + testing-library harness\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 13 — Front-end components (TDD)

### Task 20 — `ProposalList` renders ProposalView[] and fires onSelect

**Files:** Create `web/src/components/ProposalList.tsx`, `web/src/components/ProposalList.test.tsx`.

- [ ] 20.1 **RED.** Create `web/src/components/ProposalList.test.tsx`:
  ```tsx
  import { render, screen, fireEvent } from "@testing-library/react";
  import { describe, it, expect, vi } from "vitest";
  import type { ProposalView } from "@shadowkit/shared";
  import { ProposalList } from "./ProposalList";

  const sample: ProposalView[] = [
    {
      id: 0,
      actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "15000", minOut: "14000" },
      cap: "15000", deadline: 2_000_000_000, votesCast: 2, status: "Open",
      weightedYes: null, weightedNo: null,
    },
    {
      id: 1,
      actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "5000", minOut: "4800" },
      cap: "5000", deadline: 2_000_000_500, votesCast: 3, status: "Approved",
      weightedYes: "55", weightedNo: "40",
    },
  ];

  describe("ProposalList", () => {
    it("renders one row per proposal with status and votes", () => {
      render(<ProposalList proposals={sample} onSelect={() => {}} />);
      expect(screen.getByText(/Proposal #0/)).toBeInTheDocument();
      expect(screen.getByText(/Proposal #1/)).toBeInTheDocument();
      expect(screen.getByText("Open")).toBeInTheDocument();
      expect(screen.getByText("Approved")).toBeInTheDocument();
      expect(screen.getByText(/2 votes/)).toBeInTheDocument();
    });

    it("fires onSelect with the proposal id when a row is clicked", () => {
      const onSelect = vi.fn();
      render(<ProposalList proposals={sample} onSelect={onSelect} />);
      fireEvent.click(screen.getByText(/Proposal #1/));
      expect(onSelect).toHaveBeenCalledWith(1);
    });
  });
  ```
- [ ] 20.2 Run, confirm RED:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/ProposalList.test.tsx 2>&1 | tail -16
  ```
  **Expected (RED):** cannot resolve `./ProposalList` (file does not exist) → suite fails.
- [ ] 20.3 **GREEN.** Create `web/src/components/ProposalList.tsx` (props match foundation §3.7 `ProposalListProps`):
  ```tsx
  import type { ProposalView } from "@shadowkit/shared";

  export interface ProposalListProps {
    proposals: ProposalView[];
    onSelect: (id: number) => void;
  }

  export function ProposalList({ proposals, onSelect }: ProposalListProps) {
    return (
      <ul className="proposal-list">
        {proposals.map((p) => (
          <li
            key={p.id}
            className="proposal-row"
            role="button"
            tabIndex={0}
            onClick={() => onSelect(p.id)}
          >
            <span className="proposal-title">Proposal #{p.id}</span>
            <span className="proposal-status">{p.status}</span>
            <span className="proposal-votes">{p.votesCast} votes</span>
          </li>
        ))}
      </ul>
    );
  }
  ```
- [ ] 20.4 Run, confirm GREEN:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/ProposalList.test.tsx 2>&1 | tail -10
  ```
  **Expected (GREEN):** `2 passed`.
- [ ] 20.5 **COMMIT:**
  ```bash
  git add web/src/components/ProposalList.tsx web/src/components/ProposalList.test.tsx && git commit -m "$(printf 'feat(web): ProposalList renders proposals and fires onSelect\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 21 — `VoteModal` (plaintext) lets a voter pick Yes/No and submit; hides tally

**Files:** Create `web/src/components/VoteModal.tsx`, `web/src/components/VoteModal.test.tsx`.

> **M1 plaintext prop variant (recorded divergence from foundation §3.7 `VoteModalProps`):** foundation §3.7's `VoteModalProps` carries ZK fields (`voterSecret`, `merklePath`, `pathIndices`, `weight`, `merkleRoot`, `onSubmitted(nullifierHex)`) for M4. M1 is plaintext: the modal only needs the proposal, the voter address, and a callback `onCast(direction: 0|1)`. M4 swaps in the ZK props. This is the M1 plaintext form, documented here.
>
> **RECORDED SCOPE NOTE — M1 front-end is PRESENTATIONAL only (no on-chain wiring):** the M1 front-end deliverable (spec §11 "FE list+vote+tally") ships the three components (`ProposalList`, `VoteModal`, `TallyView`) as pure presentational React islands driven by props + callbacks. M1 does NOT wire `VoteModal.onCast` to an actual `GovVault.cast_vote` invocation: the typed contract client `web/src/lib/contracts.ts` (foundation §1) and wallet plumbing `web/src/lib/wallet.ts` are EXPLICITLY deferred — `contracts.ts` requires `stellar contract bindings typescript` output that depends on a deployed `gov-vault` (M0/deploy concern) and `wallet.ts` requires `smart-account-kit` connect (M2/M6). The proven FE→chain path therefore lands in a later milestone (the M2 hero loop wires the agent/executor; the passkey + bindings wiring is M6). **Consequence for exit criteria:** the M1 "demoable loop" (E6) is asserted via the Rust on-chain integration tests (Task 17), NOT via any FE-to-chain test. The `onCast` callback is tested (Task 21) to fire with the correct direction; what a host page does with that callback (eventually: call `GovVaultClient.cast_vote`) is a later-milestone integration. This note exists so the "FE vote" claim in spec §11 is not overstated for M1 — M1 delivers the vote *UI*, not the on-chain *submit*.

- [ ] 21.1 **RED.** Create `web/src/components/VoteModal.test.tsx`:
  ```tsx
  import { render, screen } from "@testing-library/react";
  import userEvent from "@testing-library/user-event";
  import { describe, it, expect, vi } from "vitest";
  import type { ProposalView } from "@shadowkit/shared";
  import { VoteModal } from "./VoteModal";

  const proposal: ProposalView = {
    id: 0,
    actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "15000", minOut: "14000" },
    cap: "15000", deadline: 2_000_000_000, votesCast: 1, status: "Open",
    // even if upstream leaked tally, the modal must NOT show it
    weightedYes: "999", weightedNo: "1",
  };

  describe("VoteModal (plaintext)", () => {
    it("submits direction=1 (yes) via onCast", async () => {
      const onCast = vi.fn();
      const user = userEvent.setup();
      render(<VoteModal proposal={proposal} voter="GVOTER" onCast={onCast} />);
      await user.click(screen.getByRole("button", { name: /vote yes/i }));
      expect(onCast).toHaveBeenCalledWith(1);
    });

    it("submits direction=0 (no) via onCast", async () => {
      const onCast = vi.fn();
      const user = userEvent.setup();
      render(<VoteModal proposal={proposal} voter="GVOTER" onCast={onCast} />);
      await user.click(screen.getByRole("button", { name: /vote no/i }));
      expect(onCast).toHaveBeenCalledWith(0);
    });

    it("NEVER displays the running tally (privacy invariant)", () => {
      render(<VoteModal proposal={proposal} voter="GVOTER" onCast={() => {}} />);
      // weightedYes is "999"; it must not appear anywhere in the modal
      expect(screen.queryByText(/999/)).not.toBeInTheDocument();
    });
  });
  ```
- [ ] 21.2 Run, confirm RED:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/VoteModal.test.tsx 2>&1 | tail -16
  ```
  **Expected (RED):** cannot resolve `./VoteModal`.
- [ ] 21.3 **GREEN.** Create `web/src/components/VoteModal.tsx`:
  ```tsx
  import type { ProposalView } from "@shadowkit/shared";

  export interface VoteModalProps {
    proposal: ProposalView;
    voter: string;            // voter address (M1 plaintext; M4 replaces with ZK props)
    onCast: (direction: 0 | 1) => void;
  }

  export function VoteModal({ proposal, voter, onCast }: VoteModalProps) {
    return (
      <div className="vote-modal" role="dialog" aria-label={`Vote on proposal ${proposal.id}`}>
        <h2>Vote on Proposal #{proposal.id}</h2>
        <p className="vote-action">
          Swap {proposal.actionSpec.amount} {proposal.actionSpec.assetIn} →{" "}
          {proposal.actionSpec.assetOut}
        </p>
        <p className="vote-voter">Voting as {voter}</p>
        {/* PRIVACY INVARIANT (foundation §7): the modal renders NO tally. It must never read
            proposal.weightedYes / proposal.weightedNo. Results are hidden until close. */}
        <div className="vote-actions">
          <button type="button" onClick={() => onCast(1)}>Vote Yes</button>
          <button type="button" onClick={() => onCast(0)}>Vote No</button>
        </div>
      </div>
    );
  }
  ```
- [ ] 21.4 Run, confirm GREEN:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/VoteModal.test.tsx 2>&1 | tail -10
  ```
  **Expected (GREEN):** `3 passed`.
- [ ] 21.5 **COMMIT:**
  ```bash
  git add web/src/components/VoteModal.tsx web/src/components/VoteModal.test.tsx && git commit -m "$(printf 'feat(web): plaintext VoteModal with yes/no submit and hidden tally\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 22 — `TallyView` renders the weighted tally post-close only

**Files:** Create `web/src/components/TallyView.tsx`, `web/src/components/TallyView.test.tsx`.

- [ ] 22.1 **RED.** Create `web/src/components/TallyView.test.tsx`:
  ```tsx
  import { render, screen } from "@testing-library/react";
  import { describe, it, expect } from "vitest";
  import type { ProposalView } from "@shadowkit/shared";
  import { TallyView } from "./TallyView";

  const closed: ProposalView = {
    id: 0,
    actionSpec: { kind: "swap", assetIn: "USDC", assetOut: "XLM", amount: "15000", minOut: "14000" },
    cap: "15000", deadline: 1, votesCast: 3, status: "Approved",
    weightedYes: "55", weightedNo: "40",
  };

  const open: ProposalView = { ...closed, status: "Open", weightedYes: null, weightedNo: null };

  describe("TallyView", () => {
    it("shows weighted yes/no and the approved outcome after close", () => {
      render(<TallyView proposal={closed} />);
      expect(screen.getByText(/Yes:\s*55/)).toBeInTheDocument();
      expect(screen.getByText(/No:\s*40/)).toBeInTheDocument();
      expect(screen.getByText(/Approved/)).toBeInTheDocument();
    });

    it("shows 'results hidden' before close (no tally)", () => {
      render(<TallyView proposal={open} />);
      expect(screen.getByText(/results hidden/i)).toBeInTheDocument();
      // no numeric tally rendered while open
      expect(screen.queryByText(/Yes:\s*\d/)).not.toBeInTheDocument();
    });
  });
  ```
- [ ] 22.2 Run, confirm RED:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/TallyView.test.tsx 2>&1 | tail -16
  ```
  **Expected (RED):** cannot resolve `./TallyView`.
- [ ] 22.3 **GREEN.** Create `web/src/components/TallyView.tsx`:
  ```tsx
  import type { ProposalView } from "@shadowkit/shared";

  export interface TallyViewProps {
    proposal: ProposalView;
  }

  /** M1 plaintext tally view. Shows results ONLY once the proposal has been closed
   *  (weightedYes/weightedNo non-null). Before close it shows "results hidden". The M5
   *  sealed-reveal equivalent is foundation §3.7 RevealedResult. */
  export function TallyView({ proposal }: TallyViewProps) {
    const revealed = proposal.weightedYes !== null && proposal.weightedNo !== null;
    if (!revealed) {
      return <div className="tally-view tally-hidden">Results hidden until close</div>;
    }
    return (
      <div className="tally-view tally-revealed">
        <p className="tally-yes">Yes: {proposal.weightedYes}</p>
        <p className="tally-no">No: {proposal.weightedNo}</p>
        <p className="tally-outcome">{proposal.status}</p>
      </div>
    );
  }
  ```
- [ ] 22.4 Run, confirm GREEN:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run src/components/TallyView.test.tsx 2>&1 | tail -10
  ```
  **Expected (GREEN):** `2 passed`.
- [ ] 22.5 Run ALL web component tests together:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run 2>&1 | tail -14
  ```
  **Expected:** `Test Files  4 passed` (ProposalList, VoteModal, TallyView, plus `packages/shared` if picked up by web config — if web config only includes `src/**`, then 3 files here), all tests passing, none skipped.
- [ ] 22.6 **COMMIT:**
  ```bash
  git add web/src/components/TallyView.tsx web/src/components/TallyView.test.tsx && git commit -m "$(printf 'feat(web): TallyView shows weighted result post-close, hidden before close\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

---

## Phase 14 — Wire `just test` + no-cheating audit

### Task 23 — Ensure `just test` runs Rust + TS layers green

**Files:** Modify `justfile`.

- [ ] 23.1 Inspect the current `justfile` `test` recipe (you already captured this in Task 0.6; re-read to be sure):
  ```bash
  grep -nA8 '^test:' /home/batuhan4/github/shadowKit/justfile || echo "(no test recipe — create one in 23.2)"
  ```
  **Expected:** the M0 `test` recipe (or its absence). Note its exact indentation style (just recipes use a leading TAB or consistent spaces).
- [ ] 23.2 Set the `test` recipe to a SINGLE concrete command set (no hedging between three invocations). Use EXACTLY ONE of the two forms below, chosen by the Task 0.6 finding (a):

  **Form A — M0 has a root `vitest.workspace.ts`** (Task 0.6 found one that includes `packages/shared` AND `web`): one root vitest run aggregates every package.
  ```make
  test:
      cargo test --workspace
      npx vitest run
  ```

  **Form B — no usable root workspace config** (the default for this plan; each package has its own config: `packages/shared/vitest.config.ts` from Task 18.0 and `web/vitest.config.ts` from Task 19): run each package explicitly. This is the concrete, verified set:
  ```make
  test:
      cargo test --workspace
      cd packages/shared && npx vitest run
      cd web && npx vitest run
  ```
  > Pick ONE form and delete the other. Match the recipe's indentation to M0's existing recipes (TAB vs spaces) so `just` parses it. Do NOT include `npm --workspace web run test` AND `npx vitest run packages/shared` AND a root `npx vitest run` together — that runs the same tests two or three times. The `web/package.json` already has a `"test": "vitest run"` script (Task 19.4) and `packages/shared/package.json` has one (Task 18.0); Form B's `cd <pkg> && npx vitest run` and `npm --workspace <pkg> run test` are equivalent — prefer the `cd ... && npx vitest run` shown (it does not depend on the `"test"` script name). Each `cd` is scoped to its line; `just` runs each recipe line in its own shell, so the `cd` does not leak.
- [ ] 23.3 Run the whole suite via `just`:
  ```bash
  cd /home/batuhan4/github/shadowKit && just test 2>&1 | tail -30
  ```
  **Expected:** Rust `test result: ok.` for `shadowkit-shared`, `gov-vault`, `fallback-amm`; TS `passed` for `@shadowkit/shared` (node env) + web components (jsdom). Exit 0, zero failures, zero ignored/skipped.
- [ ] 23.4 **COMMIT** (only if the justfile changed):
  ```bash
  git add justfile && git commit -m "$(printf 'build(repo): include gov-vault, amm, web component tests in just test\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
  ```

### Task 24 — No-cheating audit (foundation §7 grep gate)

**Files:** none (verification). 

- [ ] 24.1 Grep the M1 code for forbidden test-cheating markers:
  ```bash
  cd /home/batuhan4/github/shadowKit && grep -rn -E '#\[ignore\]|\.skip\(|\.only\(|it\.todo|xfail|assert!\(true\)|expect\(true\)\.toBe\(true\)' contracts/gov-vault contracts/fallback-amm contracts/swap-venue contracts/shared packages/shared web/src 2>&1
  ```
  **Expected:** NO output (exit 1 from grep = no matches). If any line is found, it MUST have a written justification comment per foundation §7, else FIX it before proceeding.
- [ ] 24.2 Confirm there are no `#[ignore]`d or `todo` tests and that every test file has at least one real assertion. Spot-check counts:
  ```bash
  cd /home/batuhan4/github/shadowKit && echo "Rust tests:" && grep -rc '#\[test\]' contracts/gov-vault/src/test.rs contracts/fallback-amm/src/test.rs contracts/shared/src/lib.rs && echo "TS tests:" && grep -rc 'it(' web/src/components/*.test.tsx packages/shared/src/types.test.ts
  ```
  **Expected:** `gov-vault/src/test.rs` ≥ 23 `#[test]` (init x2, create x6, cast x5 + VoteCast event x1, close x5 + ProposalClosed event x2, read accessors x5, mark x2, integration x2); `fallback-amm/src/test.rs` ≥ 9 (add_liquidity x1, swap x5, venue-agnostic x2); `shared/src/lib.rs` 1; each TS file ≥ 2 `it(`. No zero counts.
- [ ] 24.3 This audit task makes no code change and is not committed on its own. If it found and you fixed any violation, commit the fix with a `test(...)` or `fix(...)` message.

---

## Milestone exit criteria (M1 is DONE when ALL hold)

Run this final gate and confirm every box:

- [ ] E1 `cargo test --workspace` is green (zero failures, zero ignored):
  ```bash
  cd /home/batuhan4/github/shadowKit && cargo test --workspace 2>&1 | grep -E 'test result|error' | tail -20
  ```
  **Expected:** only `test result: ok.` lines, no `error`/`FAILED`.
- [ ] E2 Web component tests green:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run 2>&1 | tail -8
  ```
  **Expected:** all test files passed.
- [ ] E3 Shared TS types test green (run from the package so its node-env config is used):
  ```bash
  cd /home/batuhan4/github/shadowKit/packages/shared && npx vitest run 2>&1 | tail -8
  ```
  **Expected:** `2 passed`.
- [ ] E4 `just test` green end-to-end (Task 23.3).
- [ ] E5 No-cheating grep returns nothing (Task 24.1).
- [ ] E6 Demoable loop works in tests: `integration_vote_to_approve_flow` and `integration_no_quorum_blocks_execution` pass (Task 17), and `test_swap_constant_product_math` passes (Task 14). These ARE the M1 "✅ vote→approve" demo (spec §11) asserted as **real on-chain `Env` state** (status enum transitions + weighted tally + double-vote guard + executed flag). **Scope (recorded, see Task 21):** the M1 front-end is presentational only — the demoable governance loop is proven by the Rust on-chain integration tests, NOT by any FE→chain path. `web/src/lib/contracts.ts` (typed bindings) and the `VoteModal.onCast → GovVault.cast_vote` wiring are deferred to a later milestone; M1's `VoteModal` test asserts the callback fires with the correct direction, which is the full extent of the M1 "FE vote" claim.

---

## Test coverage matrix (every required test → task)

| Required test (task brief + foundation §7) | Task | File |
|---|---|---|
| GovVault `init` happy | 3 | `gov-vault/src/test.rs::test_init_sets_state` |
| GovVault double-init reject | 3 | `test_double_init_rejects` |
| GovVault `create_proposal` (sequential ids) | 4 | `test_create_proposal_sequential_ids` |
| `proposal()` exposes NO tally before close | 4 | `test_proposal_view_no_tally_before_close` |
| `proposal()` not-found | 4 | `test_proposal_not_found` |
| create_proposal rejects amount > cap | 4 | `test_create_proposal_rejects_amount_over_cap` |
| create_proposal rejects non-positive amount | 4 | `test_create_proposal_rejects_nonpositive_amount` |
| create_proposal rejects past/now deadline | 4 | `test_create_proposal_rejects_past_deadline` |
| `cast_vote` happy | 5 | `test_cast_vote_happy_updates_participation` |
| double-vote-by-same-voter reject (`AlreadyVoted`) | 5 | `test_double_vote_same_voter_rejected` |
| post-deadline vote reject (`DeadlinePassed`) | 5 | `test_post_deadline_vote_rejected` |
| ineligible voter reject (`NotEligible`) | 5 | `test_ineligible_voter_rejected` |
| bad direction reject (`InvalidDirection`, NOT `InvalidProof`) | 5 | `test_bad_direction_rejected` |
| `cast_vote` emits `VoteCast` event (correct payload) | 6 | `test_cast_vote_emits_votecast_event` |
| quorum pass | 9 | `test_close_quorum_pass_sets_approved` |
| quorum fail (participation) | 9 | `test_close_quorum_fail_low_participation` |
| quorum fail (no majority) | 9 | `test_close_quorum_fail_no_majority` |
| close before deadline reject | 9 | `test_close_before_deadline_rejected` |
| close twice reject | 9 | `test_close_twice_rejected` |
| `close` emits watcher-critical `ProposalClosed` (reject path) | 9 | `test_close_emits_proposalclosed_event` |
| `close` emits `ProposalClosed` (approve path) | 9 | `test_close_emits_proposalclosed_event_approved` |
| `is_approved` reflects status (approved + rejected) | 9B | `test_is_approved_reflects_status`, `test_is_approved_false_for_rejected` |
| `cap_of`/`action_of` return stored values | 9B | `test_cap_of_and_action_of_return_stored_values` |
| `cap_of` not-found → `ProposalNotFound` | 9B | `test_cap_of_not_found_panics` |
| `action_of` not-found → `ProposalNotFound` | 9B | `test_action_of_not_found_panics` |
| `mark_executed` single-shot | 10 | `test_mark_executed_single_shot` |
| `mark_executed` requires approved | 10 | `test_mark_executed_requires_approved` |
| FallbackAMM `add_liquidity` | 13 | `fallback-amm/src/test.rs::test_add_liquidity_updates_reserves` |
| constant-product correctness | 14 | `test_swap_constant_product_math`, `test_swap_reverse_direction` |
| unknown-asset reject | 14 | `test_swap_unknown_asset_rejected` |
| `min_out` slippage revert (reserves/balance unchanged) | 14 | `test_swap_slippage_revert` |
| zero-amount revert | 14 | `test_swap_zero_amount_revert` |
| reserves update (asserted in swap/add) | 13, 14 | reserves assertions in those tests |
| FallbackAMM IS the SwapVenue fallback (venue-agnostic, tested) | 16 | `test_fallback_amm_is_a_swap_venue`, `test_swap_venue_slippage_through_trait` |
| Integration vote→approve (authored in Task 10.1 batch) | 17 | `integration_vote_to_approve_flow` |
| Integration no-quorum blocks execution (negative) | 17 | `integration_no_quorum_blocks_execution` |
| FE ProposalList | 20 | `web/src/components/ProposalList.test.tsx` |
| FE VoteModal (plaintext) + hides tally | 21 | `web/src/components/VoteModal.test.tsx` |
| FE TallyView (post-close) + hidden pre-close | 22 | `web/src/components/TallyView.test.tsx` |
| Shared TS types | 18 | `packages/shared/src/types.test.ts` |

---

## Primary vs Fallback (charter rules 2 & 3) — M1

- **PRIMARY (must pass with NO fallback):** the full plaintext governance loop — `init` → `create_proposal` → `cast_vote` (auth) → `close` (quorum) → `Approved` → `mark_executed` — proven by Task 17 against **real on-chain `Env` state** (status enum transitions + weighted tally + nullifier-equivalent double-vote guard), and the **FallbackAMM constant-product swap** proven by Task 14 against **real SAC token balances**. No mocking-away of the contract under test; auth is real (`require_auth` + `mock_all_auths` only mocks the SIGNER, not the guard logic). These are green on the default `cargo test --workspace` with no feature flags.
- **FALLBACK (must also be real + tested):** for M1 the relevant fallback is the swap venue. The spec (D8) makes **FallbackAMM itself the swap-venue fallback**; the `SwapVenue` trait is the config-selectable abstraction (env `SWAP_VENUE=fallback|soroswap`, foundation §2.4). M1 ships and tests the `fallback` arm end-to-end (Task 16: FallbackAMM exercised through the venue-agnostic `SwapVenueClient`, including the slippage path). The `soroswap` arm is M6; M1's responsibility is to prove the trait is genuinely venue-agnostic so swapping venues is a config change, not a code fork. There is no untested escape hatch in M1.
- **OUT OF SCOPE for M1 (deferred, with their fallbacks, to later milestones):** ZK on-chain Groth16 verify + off-chain-verify fallback (M4); sealed timelock tally + coordinator commit-reveal + weight-unlinked + 1p1v fallbacks (M5); OZ Smart Account policy + hand-rolled `__check_auth` fallback (M2). M1's plaintext `cast_vote`/`close` are the documented precursors these milestones replace (plan header + foundation §11). **Also deferred: FE→chain wiring.** The M1 front-end ships presentational components only (Task 21 scope note); `web/src/lib/contracts.ts` typed bindings and the `VoteModal.onCast → GovVault.cast_vote` invocation land in a later milestone (M2 wires the agent/executor; M6 wires passkey + bindings). M1's "FE vote" deliverable is the vote UI + callback, proven by component tests; the on-chain governance loop is proven separately by the Rust integration tests (Task 17).

---

## API verification log (foundation §6 binding rule)

Verified 2026-06-02 via `npx ctx7@latest` before authoring API-bearing tasks:
- **`/stellar/rs-soroban-sdk`** — `#[contract]`/`#[contractimpl]`/`#[contracterror]`/`#[contractevent]`/`#[contracttype]`; `Env::default()`, `env.register(C, ())`, generated `XClient::new(&env, &id)` + `.address` field, `try_<fn>` returning `Err(Ok(Error))`; `env.ledger().set(LedgerInfo{ timestamp, protocol_version, sequence_number, network_id, base_reserve, min_temp_entry_ttl, min_persistent_entry_ttl, max_entry_ttl })` (verified field set); `env.storage().instance()/.persistent()`; `Address::generate(&env)` + `env.mock_all_auths()` + `addr.require_auth()`; `MockAuth`/`MockAuthInvoke` for scoped auth; `env.crypto().sha256(&bytes)` returns `Hash<32>`, converted to `BytesN<32>` via **`.to_bytes()`** (NOT `.into()`) — verified rs-soroban-sdk crypto example + `soroban-sdk/src/tests/contract_event.rs` (Tasks 5, 6); built-in `token::Client` / `token::StellarAssetClient`; SAC test token via `env.register_stellar_asset_contract_v2(admin)` → `.address()`. Cited inline in Tasks 3, 5, 6, 9, 12, 13.
- **`soroban_sdk::xdr::ToXdr`** — declared `pub mod xdr;` with NO `#[cfg(feature)]` gate in `soroban-sdk/src/lib.rs`; `ToXdr` is a blanket `impl<T> ToXdr for T where T: IntoVal<Env, Val> { fn to_xdr(self, env: &Env) -> Bytes }` over the `env.serialize_to_bytes` host fn (SOURCE: `gh api repos/stellar/rs-soroban-sdk/.../src/xdr.rs`, 2026-06-02). Available in `#[no_std]` cdylib (`wasm32v1-none`). Used in Tasks 5/6 to derive the `VoteCast` 32-byte voter id. Takes `self` by value.
- **Event testing (`soroban_sdk::testutils::Events`, `soroban_sdk::Event`)** — `env.events().all()` returns `ContractEvents` which (a) `impl PartialEq<Vec<(Address, Vec<Val>, Val)>>` (compare the whole list against `vec![&env, (id, ev.topics(&env), ev.data(&env)), ...]`) and (b) exposes `events() -> &[xdr::ContractEvent]`; the typed `#[contractevent]` provides `Event::topics(&env)`, `Event::data(&env)`, `Event::to_xdr(&env, &contract_id)` (SOURCE: `soroban-sdk/src/tests/contract_event.rs` `test_event_comparison_tuple_vec` + `test_data_map`, raw GitHub 2026-06-02). Used in Tasks 6 and 9 to assert `VoteCast` / watcher-critical `ProposalClosed` payloads.
- **`#[contractclient(name="SwapVenueClient")]` on a trait** produces a cross-contract typed client — used in Task 16 to prove venue-agnosticism (foundation §2.4).
- **`/testing-library/testing-library-docs`** — `render`, `screen`, `fireEvent`, `waitFor` from `@testing-library/react`; `userEvent.setup()` + `await user.click(...)`; `getByText/queryByText/getByRole/findByText`; `queryByText(...).not.toBeInTheDocument()` via `@testing-library/jest-dom`. Cited in Task 19.
- soroban-sdk `26.0.0`, vitest `4.1.8`, astro `6.4.2`, `@astrojs/react` `5.0.6` — versions from foundation §6 (verified there 2026-06-02). Re-run the ctx7 verification at the top of any task that calls these APIs if more than a few days have elapsed.

---

*End of M1 plan. All signatures reference `docs/superpowers/plans/00-foundation-interfaces.md` by section. Recorded divergences (plaintext `cast_vote`/`close`/`init`; additive `GovError` 16–22 incl. `InvalidDirection`/`ProposalAmountOverCap`/`DeadlineInPast`, none overloading binding codes 1–15; additive `DataKey` plaintext keys; M1 skips `ProposalStatus::Tallying` in single-shot close; `VoteModal` plaintext props + presentational-only FE scope; `TallyView` name) are intentional M1 precursors that M2/M4/M5 replace with the binding sealed/ZK/OZ signatures.*