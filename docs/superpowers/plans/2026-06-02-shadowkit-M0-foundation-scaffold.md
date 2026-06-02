# M0 — Scaffold & Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up the ShadowKit hybrid monorepo (Cargo workspace + npm workspace + Circom dir + `justfile`) with a working, fully-tested **build → test → deploy** pipeline proven on a trivial hello-world Soroban contract, and a frontend that builds and renders a placeholder. After M0, `just test` is green across every layer, `just deploy` deploys the hello contract to the local Stellar network AND succeeds against testnet config, and `just build` succeeds end to end: it builds the contracts to wasm, typechecks every TS package, and builds the `web` app to a rendered `dist/index.html`.

**Architecture:** A single repo root holds: a Rust Cargo workspace (`contracts/*`) standardized on `soroban-sdk = "26.0.0"` (per foundation §6); an npm workspace (`packages/*`, `agent`, `x402-services/*`, `web`) with a shared `tsconfig.base.json` and a root `vitest.config.ts` that aggregates each package as a Vitest **project** (`test.projects`; Vitest 4 removed `defineWorkspace`/`vitest.workspace.ts`); a `circuits/` directory (scaffolded only — circuit logic is M4); and a `justfile` that orchestrates all layers. A local Stellar network runs via `stellar network container start local` (Docker). SAC tokens for USDC (custom asset) and XLM (native) are wired by `scripts/deploy-local.sh`. The hello-world contract (`contracts/hello-world`, a throwaway crate proving the pipeline — it is NOT one of the six product crates in foundation §1 and is removed at the start of M1) exercises the full loop: compile to `wasm32v1-none`, unit-test under `Env`, deploy to local net, invoke.

**Tech Stack (verified foundation §6, 2026-06-02):** Rust 1.94.1 (`rust-toolchain.toml`), `wasm32v1-none` target, `soroban-sdk 26.0.0`, `stellar` CLI (stellar-cli, installed in M0), `just`, Node 26 + npm workspaces, TypeScript strict ES2022, Vitest 4.1.8 (root `vitest.config.ts` with `test.projects` — NOT `vitest.workspace.ts`, which Vitest 4 no longer loads; verified ctx7 `/vitest-dev/vitest` v4.1.6, 2026-06-02), Astro 6.4.2 + `@astrojs/react` 5.0.6 + React, Docker (local network). Circom 2.2.1 / snarkjs install is **deferred to M4** (M0 only creates the empty `circuits/vote/` directory + a `package.json` placeholder so the workspace shape matches foundation §1).

---

## Scope & non-goals

**In scope (this milestone):**
- Repo root config: `Cargo.toml`, `package.json`, `tsconfig.base.json`, `vitest.config.ts` (root, with `test.projects`), `justfile`, `rust-toolchain.toml`, `.env.example`, and `.gitignore` (already present; M0 ADDS circuit-fixture force-keep negations — Task 9).
- Empty-but-valid crate scaffolds for the SIX product crates (foundation §1: `shadowkit-shared`, `groth16-verifier`, `gov-vault`, `agent-policy`, `fallback-amm`, `swap-venue`) — each compiles as a stub so `cargo build --workspace` is green. **Their real entrypoints (§2) are implemented in M1–M5; M0 only proves they compile and are wired into the workspace.**
- One throwaway `hello-world` contract crate (with unit test + deploy) to prove the pipeline end-to-end.
- TS package scaffolds for `@shadowkit/shared` (with a real, tested `fieldToBe32Hex` so the TS test layer is non-trivially green) and placeholder packages so the npm workspace + Vitest workspace resolve.
- `scripts/net-up.sh`, `scripts/deploy-local.sh`, `scripts/snapshot-fixtures.sh` (the last is a stub that errors clearly "implemented in M4" — see Task 22; this is the ONE intentional not-yet-implemented stub and it is NOT a test).
- `web/` Astro+React app rendering a placeholder, with a render test.
- `justfile`: `net-up`, `net-down`, `build`, `build-contracts`, `build-ts`, `test`, `deploy`, `deploy-testnet`, `web-build`, `web-test`, `e2e`. A task actually RUNS `just build` and pastes success output (Task 16) so the build recipe is covered, not just declared.
- Local-network AND testnet config both work and are documented (`.env.example` + README section + `scripts/deploy-local.sh` parameterized by `$STELLAR_NETWORK`).

**Out of scope (later milestones — do NOT implement here):** any real contract logic in the six product crates (M1–M5), the Circom circuit (M4), tlock/timelock (M5), the agent middleware logic (M2–M3), x402 services (M6), passkey wallet logic (M6). M0 stubs these so the workspace compiles; their tests arrive with their milestones.

**Fallbacks:** This is infra; there is no primary/fallback algorithm pair. The "fallback" requirement here is interpreted per the milestone brief: **both local-network and testnet deploy paths must be real, config-selectable, and exercised.** `just deploy` (local) and `just deploy-testnet` are both implemented; the deploy script is parameterized by `$STELLAR_NETWORK` so there is no code fork. Local deploy is verified by running it (Task 18); testnet deploy is verified by a dry-run/build-and-validate that does not require live funds in CI but DOES execute the real command path against testnet config (Task 19 — documented gating).

---

## File Structure

Every path below maps 1:1 to foundation §1. **Responsibilities are copied verbatim from foundation §1** so the engineer can cross-check. Files marked **(stub)** compile/parse but contain only placeholder bodies whose real implementation belongs to a later milestone.

### Repo root
| Path | Responsibility (foundation §1) |
|---|---|
| `Cargo.toml` | Rust workspace root: `[workspace] members = all contracts/* crates` |
| `Cargo.lock` | committed (reproducible contract builds) — generated, committed |
| `package.json` | npm workspace root: `"workspaces": ["packages/*","agent","x402-services/*","web"]` |
| `tsconfig.base.json` | shared TS compiler options (strict, ES2022, moduleResolution bundler) |
| `vitest.config.ts` | Vitest ROOT config: `test.projects` aggregates every package as a Vitest project (Vitest 4 — `defineWorkspace`/`vitest.workspace.ts` removed) |
| `justfile` | `just test` / `just deploy` / `just build` / `just net-up` across ALL layers |
| `rust-toolchain.toml` | pins Rust 1.94.1, targets `wasm32v1-none` |
| `.env.example` | template: RPC_URL, NETWORK_PASSPHRASE, ANTHROPIC_API_KEY, DRAND_*, x402 keys |
| `.gitignore` | (already present) ignores target/, node_modules/, *.zkey, *.wasm, secrets — **M0 MODIFIES**: adds `!circuits/vote/fixtures/` force-keep negations (Task 9) |
| `README.md` | **(M0 adds)** quickstart: install toolchain, `just net-up`, `just test`, `just deploy`, local vs testnet config |

### Throwaway pipeline-proof crate (M0 only; removed in M1)
| Path | Responsibility |
|---|---|
| `contracts/hello-world/Cargo.toml` | `crate-type = ["cdylib"]`; soroban-sdk 26.0.0 |
| `contracts/hello-world/src/lib.rs` | `#[contract] HelloContract; hello(env, to) -> Vec<String>` (pipeline proof) |
| `contracts/hello-world/src/test.rs` | unit test under `Env` |

### Product crate scaffolds (compile-only stubs; real impl M1–M5; foundation §1)
| Path | Responsibility (foundation §1) | Stub note |
|---|---|---|
| `contracts/shared/Cargo.toml` | crate `shadowkit-shared`: no-std lib, depends on soroban-sdk | real types M1+ |
| `contracts/shared/src/lib.rs` | ActionSpec, ProposalStatus, ProposalView, SealedVote, QuorumCfg, shared errors | **(stub: `#![no_std]` + one placeholder type)** |
| `contracts/groth16-verifier/Cargo.toml` | crate `groth16-verifier`: cdylib; soroban-sdk | — |
| `contracts/groth16-verifier/src/lib.rs` | `#[contract] Groth16Verifier; verify_proof()` etc | **(stub: empty contract)** |
| `contracts/gov-vault/Cargo.toml` | crate `gov-vault` | — |
| `contracts/gov-vault/src/lib.rs` | `#[contract] GovVault` | **(stub: empty contract)** |
| `contracts/agent-policy/Cargo.toml` | crate `agent-policy` | — |
| `contracts/agent-policy/src/lib.rs` | `#[contract] AgentPolicy` | **(stub: empty contract)** |
| `contracts/fallback-amm/Cargo.toml` | crate `fallback-amm` | — |
| `contracts/fallback-amm/src/lib.rs` | `#[contract] FallbackAMM` | **(stub: empty contract)** |
| `contracts/swap-venue/Cargo.toml` | crate `swap-venue` | — |
| `contracts/swap-venue/src/lib.rs` | `trait SwapVenue` (Soroban contract client interface) | **(stub: empty lib)** |

### Circuits (directory shape only; logic M4)
| Path | Responsibility (foundation §1) | Stub note |
|---|---|---|
| `circuits/vote/package.json` | scripts: compile, setup, export-vk, gen-witness, prove, verify | **(stub: placeholder scripts that echo "M4")** |
| `circuits/vote/.gitkeep` | keep the dir under git | — |
| `circuits/vote/fixtures/.gitkeep` | keep the committed-fixtures dir under git; M4 puts `vote.r1cs`/`vote_final.zkey`/`verification_key.json` here | M0 creates dir + force-keep in `.gitignore` (Task 9) |

### TypeScript packages
| Path | Responsibility (foundation §1) | Stub note |
|---|---|---|
| `packages/shared/package.json` | pkg `@shadowkit/shared` | — |
| `packages/shared/tsconfig.json` | extends base | — |
| `packages/shared/src/index.ts` | re-exports | — |
| `packages/shared/src/types.ts` | ProposalView, ActionSpec, AgentLog, SealedVoteCiphertext, PublicSignals (§5) + `fieldToBe32Hex` + `toScSealedVote` (deferred-to-M5, throws) | **M0 implements types + tested `fieldToBe32Hex`; `toScSealedVote` is an intentionally-deferred surface with a negative test asserting it throws (§3.1)** |
| `packages/shared/src/types.test.ts` | tests `fieldToBe32Hex` (real, non-trivial) + negative test asserting `toScSealedVote` throws the documented M5 error | M0 |
| `packages/zk-prover/package.json` | pkg `@shadowkit/zk-prover` | **(stub package; impl M4/M5)** |
| `packages/zk-prover/src/index.ts` | generateVoteProof(), verifyVoteProof(), nullifierFor() | **(stub: throws "M4")** |
| `packages/snapshot-tool/package.json` | pkg `@shadowkit/snapshot-tool` | **(stub; impl M4)** |
| `packages/snapshot-tool/src/index.ts` | buildSnapshot() | **(stub: throws "M4")** |
| `packages/tally-reveal/package.json` | pkg `@shadowkit/tally-reveal` | **(stub; impl M5)** |
| `packages/tally-reveal/src/index.ts` | revealTally(), buildRevealArgs() | **(stub: throws "M5")** |

### Agent / x402 / web (scaffold so workspace resolves)
| Path | Responsibility (foundation §1) | Stub note |
|---|---|---|
| `agent/package.json` | pkg `@shadowkit/agent` | **(stub; impl M2/M3)** |
| `agent/src/index.ts` | AgentRunner orchestrator | **(stub: throws "M2")** |
| `x402-services/premium-data/package.json` | pkg `@shadowkit/x402-premium-data` | **(stub; impl M6)** |
| `x402-services/premium-data/src/server.ts` | GET /market/:pair | **(stub: throws "M6")** |
| `x402-services/shadowkit-api/package.json` | pkg `@shadowkit/x402-api` | **(stub; impl M6)** |
| `x402-services/shadowkit-api/src/server.ts` | POST /verify, /execute | **(stub: throws "M6")** |
| `web/package.json` | deps: astro, @astrojs/react, react, @shadowkit/shared | M0 real |
| `web/astro.config.mjs` | @astrojs/react integration; vite build target es2020 | M0 real |
| `web/tsconfig.json` | extends base | M0 real |
| `web/src/pages/index.astro` | AgentBoard shell page (placeholder) | M0 real |
| `web/src/components/Placeholder.tsx` | placeholder React island (real component for M0 render proof) | M0 real |
| `web/src/components/Placeholder.test.tsx` | render test (Vitest + Testing Library) | M0 real |
| `web/vitest.config.ts` | jsdom + `@vitejs/plugin-react` + `globals` config (the `web` Vitest project loaded by root `test.projects`) | M0 real |
| `web/vitest.setup.ts` | imports `@testing-library/jest-dom/vitest` (Testing Library matchers) | M0 real |

### Scripts
| Path | Responsibility (foundation §1) | Stub note |
|---|---|---|
| `scripts/net-up.sh` | start `stellar` quickstart container (local network) | M0 real |
| `scripts/net-down.sh` | stop the local network container | M0 real (added — net-up's pair) |
| `scripts/deploy-local.sh` | build wasm + deploy all contracts + create SAC tokens (M0: deploys hello + SACs) | M0 real |
| `scripts/snapshot-fixtures.sh` | regenerate circuit fixtures (compile+setup+sample proof) | **(stub: errors "implemented in M4")** |

---

## Conventions for every task (read once)

- **TDD red→green:** Each implementation task is split into (a) write failing test, (b) **run it, paste the EXACT command + the actual FAIL output**, (c) minimal implementation, (d) run again → paste PASS output, (e) commit. A task that is green on first run without a prior red is INVALID (foundation §7.2).
- **Commits:** Conventional Commits, scope = layer (foundation §8). End every commit body with the required footer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  Commit after every green step. Never commit to the default branch — work on branch `m0-scaffold` (created in Task 0).
- **No cheating (foundation §7):** no `#[ignore]` / `.skip` / `it.todo` / `assert!(true)` without a written same-line justification referencing the spec.
- **Exact paths only.** All paths are repo-relative to `/home/batuhan4/github/shadowKit`.
- **API verification:** every external command/API in this plan was verified 2026-06-02 (sources cited inline). Before changing any command, re-verify via `npx ctx7@latest` or the cited GitHub raw URL.
- **Non-interactive:** add non-interactive flags to any command that might prompt (user rule). Examples used below: `cargo install --locked`, `npm install` (no prompt), `docker` (no prompt). `stellar keys generate` uses `--fund` and is non-interactive.

---

## Task 0 — Branch + verify environment

**Files:** none (environment check).

- [ ] **0.1** Create the working branch:
  ```bash
  cd /home/batuhan4/github/shadowKit && git checkout -b m0-scaffold
  ```
  Expected: `Switched to a new branch 'm0-scaffold'`.
- [ ] **0.2** Verify the always-present toolchain (foundation §6):
  ```bash
  rustc --version && cargo --version && node --version && npm --version && docker --version
  ```
  Expected (substrings): `rustc 1.94.1`, `cargo 1.94.1`, `v26.0.0` (node), `11.` (npm), `Docker version`.
- [ ] **0.3** Add the wasm target (foundation §6):
  ```bash
  rustup target add wasm32v1-none
  ```
  Expected: `info: downloading component 'rust-std' for 'wasm32v1-none'` then `... installed`, OR `info: component 'rust-std' for target 'wasm32v1-none' is up to date`.
- [ ] **0.4** Install `just` if missing (foundation §6 — "NOT installed locally"):
  ```bash
  command -v just || cargo install --locked just
  just --version
  ```
  Expected: a version line like `just 1.43.x`.
- [ ] **0.5** Install the `stellar` CLI if missing (foundation §6 — `cargo install --locked stellar-cli`):
  ```bash
  command -v stellar || cargo install --locked stellar-cli
  stellar --version
  ```
  Expected: `stellar <version>` plus build info. (This may take several minutes to compile; that is expected.)
- [ ] **0.6** Confirm Docker daemon is running (needed for the local network in Task 17):
  ```bash
  docker info >/dev/null 2>&1 && echo "docker-ok" || echo "docker-NOT-running"
  ```
  Expected: `docker-ok`. If `docker-NOT-running`, start the Docker daemon before Task 17 (e.g. `sudo systemctl start docker`); do not proceed to Task 17 until this prints `docker-ok`.

> No commit in Task 0 (no files changed). All later tasks commit.

---

## Task 1 — Rust toolchain pin (`rust-toolchain.toml`)

**Files:** Create `rust-toolchain.toml`.

- [ ] **1.1** (red) Confirm the file does not yet exist and that `cargo` does not auto-select wasm:
  ```bash
  test -f /home/batuhan4/github/shadowKit/rust-toolchain.toml && echo EXISTS || echo MISSING
  ```
  Expected: `MISSING`.
- [ ] **1.2** (green) Create `rust-toolchain.toml` (foundation §6: pin 1.94.1, target `wasm32v1-none`):
  ```toml
  # rust-toolchain.toml — pin per foundation §6 (Rust 1.94.1, Soroban wasm target wasm32v1-none, P23+)
  [toolchain]
  channel = "1.94.1"
  components = ["rustfmt", "clippy"]
  targets = ["wasm32v1-none"]
  ```
- [ ] **1.3** Verify the pin is honored:
  ```bash
  cd /home/batuhan4/github/shadowKit && rustc --version
  ```
  Expected: `rustc 1.94.1 (...)`.
- [ ] **1.4** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add rust-toolchain.toml && \
  git commit -m "build(repo): pin Rust 1.94.1 + wasm32v1-none target

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2 — Cargo workspace root + hello-world crate (compiles)

**Files:** Create `Cargo.toml` (root), `contracts/hello-world/Cargo.toml`, `contracts/hello-world/src/lib.rs`.

> The hello-world contract source is copied VERBATIM from `stellar/soroban-examples/hello_world/src/lib.rs` (verified raw GitHub 2026-06-02) so the pipeline proof uses a known-good contract. The workspace root pins `soroban-sdk = "26.0.0"` (foundation §6 — standardize the whole workspace on 26.0.0 because `agent-policy` needs it via OZ).

- [ ] **2.1** (red) Try to build a non-existent workspace:
  ```bash
  cd /home/batuhan4/github/shadowKit && cargo build --workspace 2>&1 | head -3
  ```
  Expected (FAIL): `error: could not find 'Cargo.toml' in /home/batuhan4/github/shadowKit or any parent directory`.
- [ ] **2.2** (green) Create the root `Cargo.toml`. (Profile copied from the soroban-examples workspace, verified 2026-06-02.)
  ```toml
  # Cargo.toml — Rust workspace root (foundation §1, §6)
  [workspace]
  resolver = "2"
  members = [
      "contracts/hello-world",
      "contracts/shared",
      "contracts/groth16-verifier",
      "contracts/gov-vault",
      "contracts/agent-policy",
      "contracts/fallback-amm",
      "contracts/swap-venue",
  ]

  [workspace.package]
  version = "0.1.0"
  edition = "2021"

  # foundation §6: standardize the WHOLE workspace on soroban-sdk 26.0.0
  [workspace.dependencies]
  soroban-sdk = "26.0.0"

  # SOURCE: stellar/soroban-examples workspace Cargo.toml (verified raw GitHub 2026-06-02)
  [profile.release]
  opt-level = "z"
  overflow-checks = true
  debug = 0
  strip = "symbols"
  debug-assertions = false
  panic = "abort"
  codegen-units = 1
  lto = true
  ```
- [ ] **2.3** (green) Create `contracts/hello-world/Cargo.toml`:
  ```toml
  [package]
  name = "hello-world"
  version = { workspace = true }
  edition = { workspace = true }
  publish = false

  [lib]
  crate-type = ["cdylib"]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }

  [dev-dependencies]
  soroban-sdk = { workspace = true, features = ["testutils"] }
  ```
- [ ] **2.4** (green) Create `contracts/hello-world/src/lib.rs` (VERBATIM from soroban-examples hello_world, verified 2026-06-02):
  ```rust
  #![no_std]
  use soroban_sdk::{contract, contractimpl, vec, Env, String, Vec};

  #[contract]
  pub struct HelloContract;

  #[contractimpl]
  impl HelloContract {
      pub fn hello(env: Env, to: String) -> Vec<String> {
          vec![&env, String::from_str(&env, "Hello"), to]
      }
  }

  mod test;
  ```
- [ ] **2.5** Create the other six crates as MINIMAL stubs so `members` resolve (full bodies in Tasks 5–9; here just enough to compile). Create each `Cargo.toml` and a stub `src/lib.rs`:

  `contracts/shared/Cargo.toml`:
  ```toml
  [package]
  name = "shadowkit-shared"
  version = { workspace = true }
  edition = { workspace = true }
  publish = false

  [lib]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }
  ```
  `contracts/shared/src/lib.rs`:
  ```rust
  #![no_std]
  // shadowkit-shared: cross-contract types (foundation §2.6). Real types land in M1+.
  // M0 stub: a single marker so the no-std lib compiles and is wired into the workspace.
  use soroban_sdk::contracttype;

  #[contracttype]
  #[derive(Clone, Debug, PartialEq)]
  pub enum SwapKind {
      Swap,
  }
  ```

  For each of `groth16-verifier`, `gov-vault`, `agent-policy`, `fallback-amm`, create `contracts/<name>/Cargo.toml`:
  ```toml
  [package]
  name = "<name>"          # exact crate name: groth16-verifier | gov-vault | agent-policy | fallback-amm
  version = { workspace = true }
  edition = { workspace = true }
  publish = false

  [lib]
  crate-type = ["cdylib"]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }

  [dev-dependencies]
  soroban-sdk = { workspace = true, features = ["testutils"] }
  ```
  and `contracts/<name>/src/lib.rs` (empty contract stub; real entrypoints arrive in the named milestone):
  ```rust
  #![no_std]
  // <crate> stub (foundation §2). Real entrypoints land in the owning milestone.
  use soroban_sdk::{contract, contractimpl, Env};

  #[contract]
  pub struct Placeholder;

  #[contractimpl]
  impl Placeholder {
      /// M0 stub: proves the crate compiles & registers; replaced in its milestone.
      pub fn ping(_env: Env) -> u32 {
          0
      }
  }
  ```
  For `swap-venue` (a trait/interface crate — no cdylib): `contracts/swap-venue/Cargo.toml`:
  ```toml
  [package]
  name = "swap-venue"
  version = { workspace = true }
  edition = { workspace = true }
  publish = false

  [lib]
  doctest = false

  [dependencies]
  soroban-sdk = { workspace = true }
  ```
  `contracts/swap-venue/src/lib.rs`:
  ```rust
  #![no_std]
  // swap-venue: SwapVenue trait (foundation §2.4). Real trait + #[contractclient] lands in M2/M6.
  // M0 stub: empty no-std lib so the workspace member resolves.
  ```
- [ ] **2.6** Create the hello-world test file so `mod test;` resolves (this is also Task 3's red, but the file must exist for 2.7 to compile). Create `contracts/hello-world/src/test.rs` with the verbatim soroban-examples test:
  ```rust
  #![cfg(test)]

  use super::*;
  use soroban_sdk::{vec, Env, String};

  #[test]
  fn test() {
      let env = Env::default();
      let contract_id = env.register(HelloContract, ());
      let client = HelloContractClient::new(&env, &contract_id);

      let words = client.hello(&String::from_str(&env, "Dev"));
      assert_eq!(
          words,
          vec![
              &env,
              String::from_str(&env, "Hello"),
              String::from_str(&env, "Dev"),
          ]
      );
  }
  ```
- [ ] **2.7** (green) Build the whole workspace:
  ```bash
  cd /home/batuhan4/github/shadowKit && cargo build --workspace 2>&1 | tail -5
  ```
  Expected: `Compiling hello-world ...`, `Compiling shadowkit-shared ...`, ... and finally `Finished \`dev\` profile [unoptimized + debuginfo] target(s) in ...`. No errors.
- [ ] **2.8** Commit (Cargo.lock is generated by the build; commit it per foundation §1 "committed reproducible builds"):
  ```bash
  cd /home/batuhan4/github/shadowKit && git add Cargo.toml Cargo.lock contracts/ && \
  git commit -m "build(repo): scaffold cargo workspace + hello-world + crate stubs

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3 — Hello-world unit test passes under `Env`

**Files:** `contracts/hello-world/src/test.rs` (already created in 2.6).

> TDD-red note: the test file already exists, so we demonstrate red by FIRST breaking the assertion, confirming failure, then restoring it. This proves the test asserts real behavior (foundation §7: no assertion that always passes).

- [ ] **3.1** (red) Temporarily change the expected word from `"Hello"` to `"Goodbye"` in `contracts/hello-world/src/test.rs` (line: `String::from_str(&env, "Hello"),`) and run:
  ```bash
  cd /home/batuhan4/github/shadowKit && cargo test -p hello-world 2>&1 | tail -15
  ```
  Expected (FAIL): a panic `assertion \`left == right\` failed` showing `"Hello"` (actual) vs `"Goodbye"` (expected), and `test result: FAILED. 0 passed; 1 failed`.
- [ ] **3.2** (green) Restore `"Goodbye"` → `"Hello"` and run again:
  ```bash
  cd /home/batuhan4/github/shadowKit && cargo test -p hello-world 2>&1 | tail -8
  ```
  Expected: `test test::test ... ok` and `test result: ok. 1 passed; 0 failed`.
- [ ] **3.3** Run the whole workspace test to confirm the stubs don't break testing:
  ```bash
  cd /home/batuhan4/github/shadowKit && cargo test --workspace 2>&1 | tail -10
  ```
  Expected: all crates compile; `test result: ok` for hello-world; other crates report `0 tests` (stubs have none yet) — overall no failures.
- [ ] **3.4** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add contracts/hello-world/src/test.rs && \
  git commit -m "test(hello-world): unit test hello() under Env

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4 — Build the hello-world wasm artifact

**Files:** none new (uses `stellar contract build`).

> `stellar contract build` compiles every workspace cdylib to `target/wasm32v1-none/release/*.wasm` (verified foundation §6 / stellar-docs 2026-06-02). We assert the hello-world wasm exists.

- [ ] **4.1** (red) Confirm no wasm yet:
  ```bash
  ls /home/batuhan4/github/shadowKit/target/wasm32v1-none/release/hello_world.wasm 2>&1
  ```
  Expected (FAIL): `... No such file or directory`. (Note: crate `hello-world` → wasm `hello_world.wasm`; cargo replaces `-` with `_`.)
- [ ] **4.2** (green) Build the contracts to wasm:
  ```bash
  cd /home/batuhan4/github/shadowKit && stellar contract build 2>&1 | tail -8
  ```
  Expected: cargo compiles each cdylib for `wasm32v1-none`; finishes with `Finished \`release\` profile ...`. (`shadowkit-shared` and `swap-venue` are non-cdylib libs and will not emit a wasm — that is expected.)
- [ ] **4.3** Assert the artifact exists and is non-empty:
  ```bash
  ls -l /home/batuhan4/github/shadowKit/target/wasm32v1-none/release/hello_world.wasm
  ```
  Expected: a file listing with a non-zero byte size.
- [ ] **4.4** No commit (wasm is git-ignored per `.gitignore` `*.wasm`). This task proves the build target works; the `justfile` (Task 16) wires it.

---

## Task 5 — `@shadowkit/shared` TS package: `fieldToBe32Hex` (real tested logic)

**Files:** Create `package.json` (root), `tsconfig.base.json`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/types.ts`, `packages/shared/src/index.ts`, `packages/shared/src/types.test.ts`.

> Rationale: the TS test layer must be NON-trivially green in M0 (charter rule 1: every public fn has tests). `fieldToBe32Hex(decimal) -> 0x..32-byte big-endian hex` (foundation §3.1, §5) is pure, deterministic, and needed by every later contract-arg conversion — so we implement and test it now. No external API; pure BigInt math.

- [ ] **5.1** (green prerequisite) Create the npm workspace root `package.json`. NOTE on `build`: we do **NOT** use `tsc -b`. `tsc -b` (build mode) needs a root `tsconfig.json` with `references` to `composite: true` sub-projects; none exist (and adding `composite`/project references is unnecessary work for M0 stubs — YAGNI). Instead `build` typechecks every TS package with `tsc --noEmit -p <pkg>` (the SAME mechanism Tasks 7.10/8.10 already use), so `npm run build` / `just build-ts` actually validates types across the whole workspace and never trips `error TS5083: Cannot read file 'tsconfig.json'`. (`web` is excluded from the TS typecheck list because Astro `.astro` files are typechecked by `astro check` / built by `astro build` — the justfile's `build` recipe runs `build-contracts` + `build-ts` + `web-build` so the web app is covered there; see Task 16.)
  ```json
  {
    "name": "shadowkit",
    "private": true,
    "type": "module",
    "workspaces": [
      "packages/*",
      "agent",
      "x402-services/*",
      "web"
    ],
    "scripts": {
      "test": "vitest run",
      "build": "tsc --noEmit -p packages/shared/tsconfig.json && tsc --noEmit -p packages/zk-prover/tsconfig.json && tsc --noEmit -p packages/snapshot-tool/tsconfig.json && tsc --noEmit -p packages/tally-reveal/tsconfig.json && tsc --noEmit -p agent/tsconfig.json && tsc --noEmit -p x402-services/premium-data/tsconfig.json && tsc --noEmit -p x402-services/shadowkit-api/tsconfig.json"
    },
    "devDependencies": {
      "typescript": "5.7.3",
      "vitest": "4.1.8"
    }
  }
  ```
- [ ] **5.2** (green prerequisite) Create `tsconfig.base.json` (foundation §1: strict, ES2022, moduleResolution bundler):
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true,
      "declaration": true,
      "noUncheckedIndexedAccess": true,
      "verbatimModuleSyntax": true
    }
  }
  ```
- [ ] **5.3** (green prerequisite) Create `packages/shared/package.json`:
  ```json
  {
    "name": "@shadowkit/shared",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": { "test": "vitest run" }
  }
  ```
- [ ] **5.4** (green prerequisite) Create `packages/shared/tsconfig.json`:
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "include": ["src"]
  }
  ```
- [ ] **5.5** (green prerequisite) Create `packages/shared/src/types.ts` with the foundation §3.1 type defs PLUS the `fieldToBe32Hex` implementation. `toScSealedVote` is a public exported fn in this REAL (non-stub, tested) package, so charter rule 1 ("every public fn in a tested module has tests") applies to it. Its XDR shape needs the generated GovVault bindings (M5), so M0 ships it as an intentionally-deferred surface that THROWS the documented M5 error — and Task 5.7 adds a NEGATIVE test asserting it throws. That turns it from an untested public fn into a tested, intentionally-deferred one (compliant with rule 1), not a hidden skip.
  ```typescript
  // packages/shared/src/types.ts — foundation §3.1 / §5

  export type ProposalStatus = "Open" | "Tallying" | "Approved" | "Rejected" | "Executed";

  export interface ActionSpec {
    kind: "swap";
    assetIn: string;
    assetOut: string;
    amount: string;
    minOut: string;
  }

  export interface ProposalView {
    id: number;
    actionSpec: ActionSpec;
    cap: string;
    deadline: number;
    votesCast: number;
    status: ProposalStatus;
    weightedYes: string | null;
    weightedNo: string | null;
  }

  export type AgentLogPhase = "reveal" | "data" | "plan" | "sign" | "submit" | "done" | "error";

  export interface AgentLog {
    ts: number;
    phase: AgentLogPhase;
    message: string;
    txHash?: string;
  }

  export interface SealedVoteCiphertext {
    round: number;
    ciphertext: string;
    sealedCommitmentHash: string;
  }

  export interface PublicSignals {
    merkleRoot: string;
    nullifier: string;
    proposalId: string;
    sealedCommitmentHash: string;
  }

  export interface Groth16Proof {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: "groth16";
    curve: "bls12381";
  }

  export interface VoteDecryption {
    direction: 0 | 1;
    weight: string;
    sealedCommitmentHash: string;
  }

  export interface RevealArgs {
    proposalId: number;
    revealedYesW: string;
    revealedNoW: string;
    decryptions: VoteDecryption[];
  }

  /**
   * snarkjs decimal field string -> 32-byte big-endian hex (for Bls12381Fr / contract args).
   * foundation §3.1. Pure BigInt math (no external API).
   */
  export function fieldToBe32Hex(decimal: string): string {
    if (!/^\d+$/.test(decimal)) {
      throw new Error(`fieldToBe32Hex: not a decimal field string: ${decimal}`);
    }
    const n = BigInt(decimal);
    if (n < 0n) throw new Error("fieldToBe32Hex: negative");
    const hex = n.toString(16);
    if (hex.length > 64) {
      throw new Error(`fieldToBe32Hex: value exceeds 32 bytes (${hex.length / 2} bytes)`);
    }
    return "0x" + hex.padStart(64, "0");
  }

  /** Convert a SealedVoteCiphertext to the XDR/native shape for the GovVault binding.
   *  Requires generated bindings (M5) — declared here for the binding surface; not used in M0.
   *  INTENTIONALLY-DEFERRED to M5 (spec §9 milestone map): throws a documented error and is
   *  covered by a negative test (types.test.ts) asserting it throws. NOT an untested public fn. */
  export function toScSealedVote(_v: SealedVoteCiphertext): unknown {
    throw new Error("toScSealedVote: implemented in M5 (needs generated GovVault bindings)");
  }
  ```
- [ ] **5.6** (green prerequisite) Create `packages/shared/src/index.ts`:
  ```typescript
  export * from "./types.js";
  ```
- [ ] **5.7** (red) Create the failing test `packages/shared/src/types.test.ts`. It tests `fieldToBe32Hex` (5 cases) AND adds a negative test for the intentionally-deferred `toScSealedVote` (charter rule 1 — see 5.5). Total: 6 tests in this file.
  ```typescript
  import { describe, it, expect } from "vitest";
  import { fieldToBe32Hex, toScSealedVote } from "./types.js";
  import type { SealedVoteCiphertext } from "./types.js";

  describe("fieldToBe32Hex", () => {
    it("pads small values to 32 bytes big-endian", () => {
      expect(fieldToBe32Hex("1")).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      );
    });
    it("encodes 256 as big-endian 0x..0100", () => {
      expect(fieldToBe32Hex("256")).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000100",
      );
    });
    it("handles a 32-byte value (no overflow)", () => {
      const max = (2n ** 256n - 1n).toString(); // exactly 64 hex chars
      expect(fieldToBe32Hex(max)).toBe("0x" + "f".repeat(64));
    });
    it("rejects non-decimal input", () => {
      expect(() => fieldToBe32Hex("0xdead")).toThrow(/decimal field string/);
    });
    it("rejects values exceeding 32 bytes", () => {
      const tooBig = (2n ** 256n).toString();
      expect(() => fieldToBe32Hex(tooBig)).toThrow(/exceeds 32 bytes/);
    });
  });

  describe("toScSealedVote (intentionally deferred to M5 — spec §9)", () => {
    // Charter rule 1: every public fn in this REAL (tested) module has a test. toScSealedVote
    // needs the generated GovVault bindings (M5), so M0 asserts it currently throws the
    // documented M5 error — a tested, intentionally-deferred surface, not an untested public fn.
    it("throws the documented M5-deferral error", () => {
      const sample: SealedVoteCiphertext = {
        round: 1,
        ciphertext: "deadbeef",
        sealedCommitmentHash:
          "0x0000000000000000000000000000000000000000000000000000000000000001",
      };
      expect(() => toScSealedVote(sample)).toThrow(/implemented in M5/);
    });
  });
  ```
- [ ] **5.8** (red) Install deps and run the test BEFORE wiring the root `vitest.config.ts` (Task 6), to show red is reachable. First install:
  ```bash
  cd /home/batuhan4/github/shadowKit && npm install 2>&1 | tail -5
  ```
  Expected: `added N packages` (typescript + vitest). Then run just this package's test to confirm it executes:
  ```bash
  cd /home/batuhan4/github/shadowKit && npx vitest run packages/shared 2>&1 | tail -15
  ```
  Expected (GREEN — implementation already written in 5.5): `6 passed` (5 `fieldToBe32Hex` + 1 `toScSealedVote` deferral). To demonstrate RED per charter, temporarily change the `"256"` expectation in the test to end in `...0101` and re-run → expect `1 failed` with a diff showing `...0100` vs `...0101`; then revert to `...0100` and re-run → `6 passed`. Paste both outputs.
- [ ] **5.9** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add package.json package-lock.json tsconfig.base.json packages/shared && \
  git commit -m "feat(shared): @shadowkit/shared types + tested fieldToBe32Hex

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6 — Vitest root config aggregates all TS packages via `test.projects`

**Files:** Create `vitest.config.ts` (repo root).

> **CRITICAL API NOTE (verified ctx7 `/vitest-dev/vitest` v4.1.6, 2026-06-02 — same major as the pinned 4.1.8).** Vitest 4 **removed** `defineWorkspace` (`import { defineWorkspace } from "vitest/config"` throws `SyntaxError: ... does not provide an export named 'defineWorkspace'`) and **no longer auto-loads a `vitest.workspace.ts` file** — the `workspace` option was renamed to `test.projects` in 3.2 and the standalone workspace file was dropped in 4. The migration guide is explicit: "`workspace` is replaced with `projects`" and "move the code from `vitest.workspace.js` directly into the `projects` array in `vitest.config.ts`." So we create a ROOT `vitest.config.ts` whose `test.projects` lists each package by path. A glob/path entry resolves that folder's OWN config (so `web` loads `web/vitest.config.ts` with jsdom + `@vitejs/plugin-react`) or its `package.json` (so `packages/shared` runs under the default **node** environment). This is the mechanism `vitest run`, root `npm test`, and `just test` all rely on; without it `vitest run` would fall back to default glob discovery and run `web/src/components/Placeholder.test.tsx` WITHOUT its jsdom/react config (→ `ReferenceError: it is not defined` / JSX transform failure). SOURCES: vitest v4.1.6 `docs/guide/migration.md` ("workspace is Replaced with projects"), `docs/guide/projects.md` (glob `'packages/*'` + per-folder config), `docs/guide/examples/projects-workspace.md`.

- [ ] **6.1** (red) Confirm the root `vitest.config.ts` is missing, AND demonstrate that a bare `vitest run` does NOT correctly aggregate yet. First confirm the file is missing:
  ```bash
  test -f /home/batuhan4/github/shadowKit/vitest.config.ts && echo EXISTS || echo MISSING
  ```
  Expected: `MISSING`. (There is intentionally NO `vitest.workspace.ts` anywhere — Vitest 4 would silently ignore it.)
- [ ] **6.2** (green) Create the root `vitest.config.ts`. The path entries point at each package folder; Vitest loads each folder's own config (`web/vitest.config.ts`) or falls back to that package's defaults (node env) when it has none:
  ```typescript
  // vitest.config.ts — root Vitest config. Aggregates every TS package as a PROJECT.
  // Vitest 4 removed `defineWorkspace`/`vitest.workspace.ts`; use `test.projects` instead.
  // Verified ctx7 /vitest-dev/vitest v4.1.6 migration guide ("workspace -> projects"), 2026-06-02.
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    test: {
      projects: [
        "packages/*",      // @shadowkit/shared (+ stub pkgs) — default node env
        "agent",           // @shadowkit/agent stub
        "x402-services/*", // x402 service stubs
        "web",             // loads web/vitest.config.ts (jsdom + @vitejs/plugin-react)
      ],
    },
  });
  ```
- [ ] **6.3** Run the root vitest to confirm `test.projects` aggregation finds `packages/shared` (the only package with tests at this point in the plan — `web` tests arrive in Task 11):
  ```bash
  cd /home/batuhan4/github/shadowKit && npx vitest run 2>&1 | tail -15
  ```
  Expected: the `packages/shared` project reports `6 passed` (5 `fieldToBe32Hex` + 1 `toScSealedVote`); overall `Test Files  1 passed`, `Tests  6 passed`. Each project is listed by its package name. No failures, and crucially NO `SyntaxError` about `defineWorkspace` (which the removed approach would have thrown).
- [ ] **6.4** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add vitest.config.ts && \
  git commit -m "build(repo): root vitest.config.ts aggregating packages via test.projects

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7 — TS package stubs (zk-prover, snapshot-tool, tally-reveal) compile

**Files:** Create `packages/zk-prover/{package.json,tsconfig.json,src/index.ts}`, `packages/snapshot-tool/{package.json,tsconfig.json,src/index.ts}`, `packages/tally-reveal/{package.json,tsconfig.json,src/index.ts}`.

> These are SCAFFOLD stubs (impl M4/M5). Their public functions throw a clear "implemented in Mx" error. This is NOT a skipped test — there are no tests yet; the stub exists so the npm workspace resolves and `@shadowkit/shared` consumers can import the package names. Each stub exposes the foundation §3 signatures as type-only declarations + throwing bodies.

- [ ] **7.1** Create `packages/zk-prover/package.json`:
  ```json
  {
    "name": "@shadowkit/zk-prover",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": { "test": "vitest run" },
    "dependencies": { "@shadowkit/shared": "0.1.0" }
  }
  ```
- [ ] **7.2** Create `packages/zk-prover/tsconfig.json`:
  ```json
  { "extends": "../../tsconfig.base.json", "include": ["src"] }
  ```
- [ ] **7.3** Create `packages/zk-prover/src/index.ts` (stub matching foundation §3.2 signatures):
  ```typescript
  // @shadowkit/zk-prover — STUB (foundation §3.2). Real impl: M4 (proof) + M5 (seal).
  import type { Groth16Proof, PublicSignals, SealedVoteCiphertext } from "@shadowkit/shared";

  export interface VoteInput {
    secret: string;
    merklePath: string[];
    pathIndices: number[];
    weight: string;
    proposalId: string;
    direction: 0 | 1;
    merkleRoot: string;
  }
  export interface VoteProofResult {
    proof: Groth16Proof;
    publicSignals: PublicSignals;
    sealedCiphertext: SealedVoteCiphertext;
  }
  export interface DrandConfig {
    chainUrl: string;
    chainHash: string;
  }

  export function generateVoteProof(
    _input: VoteInput,
    _artifacts: { wasmPath: string; zkeyPath: string },
    _deadlineUnixSeconds: number,
    _drand?: DrandConfig,
  ): Promise<VoteProofResult> {
    throw new Error("generateVoteProof: implemented in M4/M5");
  }
  export function verifyVoteProof(
    _vkey: object,
    _publicSignals: PublicSignals,
    _proof: Groth16Proof,
  ): Promise<boolean> {
    throw new Error("verifyVoteProof: implemented in M4");
  }
  export function nullifierFor(_secret: string, _proposalId: string): string {
    throw new Error("nullifierFor: implemented in M4");
  }
  ```
- [ ] **7.4** Create `packages/snapshot-tool/package.json`:
  ```json
  {
    "name": "@shadowkit/snapshot-tool",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": { "test": "vitest run" }
  }
  ```
- [ ] **7.5** Create `packages/snapshot-tool/tsconfig.json`:
  ```json
  { "extends": "../../tsconfig.base.json", "include": ["src"] }
  ```
- [ ] **7.6** Create `packages/snapshot-tool/src/index.ts` (stub matching foundation §3.3):
  ```typescript
  // @shadowkit/snapshot-tool — STUB (foundation §3.3). Real impl: M4.
  export interface Holder {
    secretCommit: string;
    weight: string;
  }
  export interface Snapshot {
    root: string;
    rootBe32Hex: string;
    getPath(leafIndex: number): { merklePath: string[]; pathIndices: number[] };
    leafCount: number;
    depth: number;
  }
  export function buildSnapshot(_holders: Holder[], _depth?: number): Snapshot {
    throw new Error("buildSnapshot: implemented in M4");
  }
  ```
- [ ] **7.7** Create `packages/tally-reveal/package.json`:
  ```json
  {
    "name": "@shadowkit/tally-reveal",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": { "test": "vitest run" },
    "dependencies": { "@shadowkit/shared": "0.1.0", "@shadowkit/zk-prover": "0.1.0" }
  }
  ```
- [ ] **7.8** Create `packages/tally-reveal/tsconfig.json`:
  ```json
  { "extends": "../../tsconfig.base.json", "include": ["src"] }
  ```
- [ ] **7.9** Create `packages/tally-reveal/src/index.ts` (stub matching foundation §3.4):
  ```typescript
  // @shadowkit/tally-reveal — STUB (foundation §3.4). Real impl: M5.
  import type { SealedVoteCiphertext, RevealArgs } from "@shadowkit/shared";
  import type { DrandConfig } from "@shadowkit/zk-prover";

  export function revealTally(
    _sealedVotes: SealedVoteCiphertext[],
    _drand?: DrandConfig,
  ): Promise<{ yesW: string; noW: string; decrypted: Array<{ direction: 0 | 1; weight: string }> }> {
    throw new Error("revealTally: implemented in M5");
  }
  export function buildRevealArgs(
    _proposalId: number,
    _sealedVotes: SealedVoteCiphertext[],
    _drand?: DrandConfig,
  ): Promise<RevealArgs> {
    throw new Error("buildRevealArgs: implemented in M5");
  }
  ```
- [ ] **7.10** Install (links new workspace packages) and typecheck:
  ```bash
  cd /home/batuhan4/github/shadowKit && npm install 2>&1 | tail -3 && \
  npx tsc -p packages/zk-prover/tsconfig.json --noEmit && \
  npx tsc -p packages/snapshot-tool/tsconfig.json --noEmit && \
  npx tsc -p packages/tally-reveal/tsconfig.json --noEmit && echo "TYPECHECK-OK"
  ```
  Expected: no type errors; ends with `TYPECHECK-OK`.
- [ ] **7.11** Confirm the root `vitest.config.ts` aggregation still passes (the new stub projects have no test files, but they must not error during project resolution/collection):
  ```bash
  cd /home/batuhan4/github/shadowKit && npx vitest run 2>&1 | tail -10
  ```
  Expected: `Tests  6 passed` (shared: 5 `fieldToBe32Hex` + 1 `toScSealedVote`) and no collection errors. The new stub packages contribute no test files. Vitest's `passWithNoTests` defaults to `false`, but that only fails the run when the ENTIRE run (across ALL projects) found zero test files — here `packages/shared` has tests, so the overall run finds test files and passes; the per-project empty results do NOT fail the aggregate. (Verified semantics: ctx7 `/vitest-dev/vitest` v4.1.6 `docs/config/passwithnotests.md` + `onTestRunEnd` "state depends on config.passWithNoTests" applies only when no files are found at all.)
- [ ] **7.12** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add packages/zk-prover packages/snapshot-tool packages/tally-reveal package-lock.json && \
  git commit -m "build(repo): scaffold zk-prover/snapshot-tool/tally-reveal TS stubs

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 8 — Agent + x402 service stubs compile

**Files:** Create `agent/{package.json,tsconfig.json,src/index.ts}`, `x402-services/premium-data/{package.json,tsconfig.json,src/server.ts}`, `x402-services/shadowkit-api/{package.json,tsconfig.json,src/server.ts}`.

- [ ] **8.1** Create `agent/package.json`:
  ```json
  {
    "name": "@shadowkit/agent",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": { "test": "vitest run" },
    "dependencies": { "@shadowkit/shared": "0.1.0" }
  }
  ```
- [ ] **8.2** Create `agent/tsconfig.json`:
  ```json
  { "extends": "../tsconfig.base.json", "include": ["src"] }
  ```
- [ ] **8.3** Create `agent/src/index.ts` (stub matching foundation §3.5 AgentRunner surface):
  ```typescript
  // @shadowkit/agent — STUB (foundation §3.5). Real impl: M2 (deterministic) + M3 (Claude).
  import type { AgentLog } from "@shadowkit/shared";

  export interface AgentConfig {
    rpcUrl: string;
    networkPassphrase: string;
    govVaultId: string;
    agentPolicyId: string;
    swapVenueId: string;
    sessionSecretKey: string;
    premiumDataUrl: string;
    anthropicApiKey: string;
    useDeterministicPlanner: boolean;
  }

  export class AgentRunner {
    constructor(private cfg: AgentConfig) {}
    run(_proposalId: number, _onLog: (l: AgentLog) => void): Promise<{ txHash: string }> {
      throw new Error("AgentRunner.run: implemented in M2/M3");
    }
  }
  ```
- [ ] **8.4** Create `x402-services/premium-data/package.json`:
  ```json
  {
    "name": "@shadowkit/x402-premium-data",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/server.ts",
    "scripts": { "test": "vitest run" }
  }
  ```
- [ ] **8.5** Create `x402-services/premium-data/tsconfig.json`:
  ```json
  { "extends": "../../tsconfig.base.json", "include": ["src"] }
  ```
- [ ] **8.6** Create `x402-services/premium-data/src/server.ts` (stub matching foundation §3.6 — real x402 wiring is M6):
  ```typescript
  // @shadowkit/x402-premium-data — STUB (foundation §3.6). Real x402 wiring: M6.
  export function createPremiumDataServer(_cfg: {
    payTo: string;
    network: "stellar:testnet" | "stellar:pubnet";
    priceUsdc: string;
    facilitatorUrl: string;
  }): unknown {
    throw new Error("createPremiumDataServer: implemented in M6");
  }
  ```
- [ ] **8.7** Create `x402-services/shadowkit-api/package.json`:
  ```json
  {
    "name": "@shadowkit/x402-api",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./src/server.ts",
    "scripts": { "test": "vitest run" }
  }
  ```
- [ ] **8.8** Create `x402-services/shadowkit-api/tsconfig.json`:
  ```json
  { "extends": "../../tsconfig.base.json", "include": ["src"] }
  ```
- [ ] **8.9** Create `x402-services/shadowkit-api/src/server.ts`:
  ```typescript
  // @shadowkit/x402-api — STUB (foundation §3.6). Real x402 wiring: M6.
  export function createShadowKitApiServer(_cfg: {
    payTo: string;
    network: "stellar:testnet" | "stellar:pubnet";
    govVaultId: string;
    rpcUrl: string;
    facilitatorUrl: string;
  }): unknown {
    throw new Error("createShadowKitApiServer: implemented in M6");
  }
  ```
- [ ] **8.10** Install + typecheck:
  ```bash
  cd /home/batuhan4/github/shadowKit && npm install 2>&1 | tail -3 && \
  npx tsc -p agent/tsconfig.json --noEmit && \
  npx tsc -p x402-services/premium-data/tsconfig.json --noEmit && \
  npx tsc -p x402-services/shadowkit-api/tsconfig.json --noEmit && echo "TYPECHECK-OK"
  ```
  Expected: `TYPECHECK-OK`.
- [ ] **8.11** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add agent x402-services package-lock.json && \
  git commit -m "build(repo): scaffold agent + x402-services TS stubs

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 9 — Circuits directory scaffold (shape only; logic M4) + fixture force-keep in `.gitignore`

**Files:** Create `circuits/vote/package.json`, `circuits/vote/.gitkeep`, `circuits/vote/fixtures/.gitkeep`. Modify `.gitignore`.

> M0 only creates the directory shape so foundation §1 matches; Circom 2.2.1 / snarkjs install is M4. The `package.json` scripts echo a clear "M4" message so an engineer running them gets a non-cryptic result (not a silent no-op).
>
> **.gitignore force-keep (fixes a false foundation invariant).** The existing `.gitignore` globally ignores `*.r1cs`, `*.zkey`, `*.ptau` and only has a COMMENT ("keep committed fixtures under circuits/fixtures/") — there is NO `!`-negation, so M4's committed fixtures (`circuits/vote/fixtures/vote_final.zkey`, `vote.r1cs`, `verification_key.json`) would be silently git-ignored. foundation §7.2 previously claimed the path was "already" force-kept; that was false. M0 is the natural place to fix it while scaffolding `circuits/`, so this task adds explicit negations and VERIFIES them with `git check-ignore` (foundation §7.2 has been corrected to match).

- [ ] **9.1** Create `circuits/vote/package.json`. The `test` script is an explicit, documented no-op until M4 (the circuit is spec §11 / milestone M4 — there is genuinely no circuit to test in M0). It is NOT an always-passing assertion: it asserts nothing, prints a clear deferral message, and is whitelisted by the Task 21 no-cheating audit with a same-line justification.
  ```json
  {
    "name": "@shadowkit/circuit-vote",
    "version": "0.1.0",
    "private": true,
    "scripts": {
      "compile": "echo 'circom compile: implemented in M4' && exit 1",
      "setup": "echo 'groth16 setup: implemented in M4' && exit 1",
      "export-vk": "echo 'export-vk: implemented in M4' && exit 1",
      "gen-witness": "echo 'gen-witness: implemented in M4' && exit 1",
      "prove": "echo 'prove: implemented in M4' && exit 1",
      "verify": "echo 'verify: implemented in M4' && exit 1",
      "test": "echo 'M4 — no circuit tests yet (circuit is milestone M4 / spec §11); deferred no-op' && exit 0"
    }
  }
  ```
  > Note: `circuits/vote` is intentionally NOT in the npm workspace `workspaces` glob (the root glob is `packages/*`, not `circuits/*`), so its `exit 1` script-stubs never break `just test`. Its `test` script returns 0 (no circuit yet) and is invoked only by the dedicated `just circuit-test` recipe (Task 16). The message is deliberately worded `M4 — no circuit tests yet ...` so it reads as a transparent deferral, not a real green suite. Task 21 (no-cheating audit) explicitly whitelists this ONE documented no-op.
- [ ] **9.2** Create `circuits/vote/.gitkeep` (empty file) so the directory is tracked even though `fixtures/` artifacts are git-ignored.
- [ ] **9.3** Create `circuits/vote/fixtures/.gitkeep` (empty file) so the committed-fixtures directory exists in git from M0 (M4 drops the real `*.zkey`/`*.r1cs`/`verification_key.json` here):
  ```bash
  mkdir -p /home/batuhan4/github/shadowKit/circuits/vote/fixtures && \
  touch /home/batuhan4/github/shadowKit/circuits/vote/fixtures/.gitkeep
  ```
- [ ] **9.4** (modify `.gitignore`) Append the circuit-fixture force-keep block to `.gitignore`. The existing file ends with the `# OS / editor` block; add this AFTER the Circom section (placement does not matter for git as long as the negations come after the `*.r1cs`/`*.zkey`/`*.ptau` ignores, which they do since they are appended at the end). Add exactly:
  ```gitignore

  # Keep committed circuit fixtures (M4 puts vote.r1cs / vote_final.zkey / verification_key.json here).
  # The global *.r1cs / *.zkey / *.ptau ignores above would otherwise hide them — re-include this path.
  !circuits/vote/fixtures/
  !circuits/vote/fixtures/*.r1cs
  !circuits/vote/fixtures/*.zkey
  !circuits/vote/fixtures/*.ptau
  !circuits/vote/fixtures/*.json
  ```
  > Why each line: `!circuits/vote/fixtures/` re-includes the directory itself; the per-extension negations re-include files whose extension is globally ignored (`*.r1cs`/`*.zkey`/`*.ptau`). `*.json` is not globally ignored but is negated for symmetry/explicitness. Git requires the directory to be re-included before its contents can be.
- [ ] **9.5** Verify the placeholder test script returns 0:
  ```bash
  cd /home/batuhan4/github/shadowKit/circuits/vote && npm test 2>&1 | tail -3
  ```
  Expected: `M4 — no circuit tests yet (circuit is milestone M4 / spec §11); deferred no-op` and exit 0.
- [ ] **9.6** Verify the force-keep actually works (a path-by-path proof, not a guess). **IMPORTANT git semantics (verified empirically 2026-06-02):** `git check-ignore -v <path>` exits `0` whenever ANY rule matches — INCLUDING a `!`-negation rule — so its exit code is MISLEADING for force-kept paths (it would say `0` for a negated fixture even though the fixture is committable). Use these two unambiguous checks instead: (a) **plain** `git check-ignore <path>` (no `-v`) exits `1` for a NOT-ignored (force-kept) path and `0` for an ignored path; (b) `git add --dry-run` (`-An`) is the ground truth — it prints `add '<path>'` for committable paths and an "ignored by one of your .gitignore files" hint for ignored ones. These fixture files do not physically exist yet (M4 creates them), so we test the patterns against not-yet-existing paths via `git check-ignore` (which works on patterns regardless of file existence) and against the real `.gitkeep` via `git add -An`.
  ```bash
  cd /home/batuhan4/github/shadowKit && \
  echo "--- plain check-ignore: force-kept fixtures should be NOT ignored (expect exit=1) ---" && \
  git check-ignore circuits/vote/fixtures/vote_final.zkey >/dev/null 2>&1; echo "zkey-in-fixtures exit=$? (want 1)" && \
  git check-ignore circuits/vote/fixtures/vote.r1cs >/dev/null 2>&1; echo "r1cs-in-fixtures exit=$? (want 1)" && \
  git check-ignore circuits/vote/fixtures/verification_key.json >/dev/null 2>&1; echo "vk-json exit=$? (want 1)" && \
  echo "--- plain check-ignore: a .zkey OUTSIDE fixtures should STILL be ignored (expect exit=0) ---" && \
  git check-ignore circuits/vote/build/foo.zkey >/dev/null 2>&1; echo "zkey-outside exit=$? (want 0)" && \
  echo "--- ground-truth: git add --dry-run on the real fixtures .gitkeep ---" && \
  git add -An circuits/vote/fixtures/.gitkeep
  ```
  Expected: `zkey-in-fixtures exit=1`, `r1cs-in-fixtures exit=1`, `vk-json exit=1` (all NOT ignored → committable at M4), `zkey-outside exit=0` (still ignored), and the dry-run prints `add 'circuits/vote/fixtures/.gitkeep'`. If any force-kept path shows `exit=0` in the plain check, the negations are wrong — fix before committing.
- [ ] **9.7** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add circuits .gitignore && \
  git commit -m "build(circuit): scaffold circuits/vote dir + force-keep fixtures in .gitignore (logic in M4)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 10 — Web app scaffold: Astro + React placeholder

**Files:** Create `web/package.json`, `web/astro.config.mjs`, `web/tsconfig.json`, `web/src/pages/index.astro`, `web/src/components/Placeholder.tsx`.

> Verified foundation §6: `astro 6.4.2`, `@astrojs/react 5.0.6`, vite build target `es2020`. We hand-author the minimal Astro+React app rather than `npm create astro` (interactive; user rule forbids prompts). Component prop contract for M0 is local (no foundation component is required to render at M0 — Placeholder is M0-only and is replaced by the real islands in M1+).

- [ ] **10.1** Create `web/package.json` (pin versions from foundation §6; React 19 is the current major paired with @astrojs/react 5):
  ```json
  {
    "name": "web",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "astro dev",
      "build": "astro build",
      "preview": "astro preview",
      "test": "vitest run"
    },
    "dependencies": {
      "astro": "6.4.2",
      "@astrojs/react": "5.0.6",
      "react": "19.0.0",
      "react-dom": "19.0.0",
      "@shadowkit/shared": "0.1.0"
    },
    "devDependencies": {
      "@types/react": "19.0.0",
      "@types/react-dom": "19.0.0",
      "@testing-library/react": "16.1.0",
      "@testing-library/jest-dom": "6.6.3",
      "jsdom": "25.0.1"
    }
  }
  ```
- [ ] **10.2** Create `web/astro.config.mjs` (foundation §1: @astrojs/react integration + vite build target es2020):
  ```javascript
  // @ts-check
  import { defineConfig } from "astro/config";
  import react from "@astrojs/react";

  // foundation §1/§6: @astrojs/react integration; vite build target es2020 (tlock-js req at M5)
  export default defineConfig({
    integrations: [react()],
    vite: {
      build: { target: "es2020" },
    },
  });
  ```
- [ ] **10.3** Create `web/tsconfig.json`:
  ```json
  {
    "extends": "../tsconfig.base.json",
    "compilerOptions": {
      "jsx": "react-jsx",
      "types": ["@testing-library/jest-dom"]
    },
    "include": ["src", "*.ts", "*.mjs"]
  }
  ```
- [ ] **10.4** Create `web/src/components/Placeholder.tsx` (the real M0 component the render test asserts on):
  ```tsx
  // web/src/components/Placeholder.tsx — M0 placeholder island (replaced by real islands in M1+).
  export interface PlaceholderProps {
    title: string;
  }

  export default function Placeholder({ title }: PlaceholderProps) {
    return (
      <main data-testid="agentboard-placeholder">
        <h1>{title}</h1>
        <p>ShadowKit AgentBoard — scaffold online. Voting & agent UI arrive in M1+.</p>
      </main>
    );
  }
  ```
- [ ] **10.5** Create `web/src/pages/index.astro` (renders the React island):
  ```astro
  ---
  import Placeholder from "../components/Placeholder.tsx";
  ---
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>ShadowKit AgentBoard</title>
    </head>
    <body>
      <Placeholder title="ShadowKit AgentBoard" client:load />
    </body>
  </html>
  ```
- [ ] **10.6** Install web deps:
  ```bash
  cd /home/batuhan4/github/shadowKit && npm install 2>&1 | tail -5
  ```
  Expected: `added N packages` including astro, react.
- [ ] **10.7** Build the web app (proves it BUILDS — milestone primary):
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npm run build 2>&1 | tail -12
  ```
  Expected: `[build] Complete!` and a `dist/` directory with `index.html`. Confirm the rendered HTML contains the title:
  ```bash
  grep -o "ShadowKit AgentBoard" /home/batuhan4/github/shadowKit/web/dist/index.html | head -1
  ```
  Expected: `ShadowKit AgentBoard`.
- [ ] **10.8** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add web package-lock.json && \
  git commit -m "feat(web): Astro + React AgentBoard placeholder that builds

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 11 — Web render test (Vitest + Testing Library)

**Files:** Create `web/vitest.config.ts`, `web/src/components/Placeholder.test.tsx`.

> foundation §7.2 frontend taxonomy: components render-tested. M0 tests the Placeholder renders its title and the M1+ marker copy.

- [ ] **11.1** Create `web/vitest.config.ts` (jsdom env so React renders). This is the per-project config the root `vitest.config.ts` `test.projects` entry `"web"` loads (Task 6), so when `vitest run` aggregates, the `web` project runs under jsdom + the React transform — NOT the default node env. We give it an explicit `name` and `include` so the project is unambiguous in aggregated output and only collects web's own `*.test.tsx`:
  ```typescript
  import { defineConfig } from "vitest/config";
  import react from "@vitejs/plugin-react";

  export default defineConfig({
    plugins: [react()],
    test: {
      name: "web",
      include: ["src/**/*.test.{ts,tsx}"],
      environment: "jsdom",
      globals: true,
      setupFiles: ["./vitest.setup.ts"],
    },
  });
  ```
- [ ] **11.2** Create `web/vitest.setup.ts`:
  ```typescript
  import "@testing-library/jest-dom/vitest";
  ```
- [ ] **11.3** Add `@vitejs/plugin-react` AND an explicit `vite` pin to `web/package.json` devDependencies (the Vitest React transform + a deterministic Vite). VERSION RATIONALE (verified via `npm view`, 2026-06-02): Vitest `4.1.8` depends on `vite@^6 || ^7 || ^8`; Astro `6.4.2` depends on `vite@^7.3.2`; `@vitejs/plugin-react@5.0.3`'s peer is `vite@^4 || ^5 || ^6 || ^7`. The intersection that keeps the web package on a SINGLE Vite major (so the Vitest run and Astro agree) is **Vite 7** + **plugin-react 5.0.3**. We therefore pin `vite@7.3.5` (latest 7.x, satisfies both vitest's dep range and Astro's `^7.3.2`) and `@vitejs/plugin-react@5.0.3`. Do NOT use the older `@vitejs/plugin-react@4.3.4` — its peer caps at `vite@^6` and excludes Vite 7, so it would conflict with the resolved Vite. Do NOT use `@vitejs/plugin-react@6.x` — its peer is `vite@^8` only, which would force a second Vite major into the web package. Edit `web/package.json` devDependencies to add:
  ```json
  "@vitejs/plugin-react": "5.0.3",
  "vite": "7.3.5"
  ```
  Then install:
  ```bash
  cd /home/batuhan4/github/shadowKit && npm install 2>&1 | tail -3
  ```
  Expected: install succeeds with NO `ERESOLVE`/peer-dependency conflict warning for `vite` / `@vitejs/plugin-react` / `vitest` / `astro`. If npm reports an `ERESOLVE` peer conflict, STOP and re-verify the trio with `npm view <pkg>@<ver> peerDependencies` before changing versions — do not pass `--force`/`--legacy-peer-deps` to paper over a real incompatibility (charter rule 5).
- [ ] **11.4** (red) Create `web/src/components/Placeholder.test.tsx`:
  ```tsx
  import { describe, it, expect } from "vitest";
  import { render, screen } from "@testing-library/react";
  import Placeholder from "./Placeholder.js";

  describe("Placeholder", () => {
    it("renders the given title", () => {
      render(<Placeholder title="ShadowKit AgentBoard" />);
      expect(screen.getByRole("heading", { name: "ShadowKit AgentBoard" })).toBeInTheDocument();
    });
    it("shows the scaffold-online marker", () => {
      render(<Placeholder title="x" />);
      expect(screen.getByTestId("agentboard-placeholder")).toHaveTextContent(/scaffold online/i);
    });
  });
  ```
- [ ] **11.5** (red) Run just the web suite. To demonstrate red, FIRST run with a deliberately wrong expectation: temporarily change `name: "ShadowKit AgentBoard"` to `name: "Nope"` and run:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run 2>&1 | tail -15
  ```
  Expected (FAIL): `Unable to find an accessible element with the role "heading" and name "Nope"` → `1 failed`.
- [ ] **11.6** (green) Revert `"Nope"` → `"ShadowKit AgentBoard"` and run:
  ```bash
  cd /home/batuhan4/github/shadowKit/web && npx vitest run 2>&1 | tail -8
  ```
  Expected: `2 passed`.
- [ ] **11.7** Confirm the root `vitest.config.ts` aggregation now includes the `web` project, running it under jsdom+react via its own `web/vitest.config.ts` (this is the exact thing `just test` / root `npm test` invoke — proving the `test.projects` mechanism applies each project's environment):
  ```bash
  cd /home/batuhan4/github/shadowKit && npx vitest run 2>&1 | tail -12
  ```
  Expected: two projects run — `packages/shared` (6 tests, node env) + `web` (2 tests, jsdom env) → `Tests  8 passed` overall, `Test Files  2 passed`, no failures. The `web` suite MUST pass (no `ReferenceError: it is not defined`, no JSX-transform error) — that is the proof the `web` project loaded `web/vitest.config.ts` (jsdom + `globals: true` + `@vitejs/plugin-react`) rather than the default node env. Paste the full aggregated output.
- [ ] **11.8** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add web package-lock.json && \
  git commit -m "test(web): render test for AgentBoard placeholder

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 12 — `.env.example` (local + testnet config documented)

**Files:** Create `.env.example`.

> foundation §1: template for RPC_URL, NETWORK_PASSPHRASE, ANTHROPIC_API_KEY, DRAND_*, x402 keys. Network passphrases verified against stellar-docs (2026-06-02): local quickstart = `Standalone Network ; February 2017`; testnet = `Test SDF Network ; September 2015`. This file is the source of truth for the local-vs-testnet config switch (the "fallback" requirement of this milestone).

- [ ] **12.1** Create `.env.example`:
  ```bash
  # .env.example — ShadowKit config template (foundation §1). Copy to .env and fill in.
  # The deploy scripts and agent read STELLAR_NETWORK to pick local vs testnet (no code fork).

  # ---- Network selection (local | testnet) ----
  STELLAR_NETWORK=local

  # ---- Local Stellar quickstart (Docker) — used when STELLAR_NETWORK=local ----
  # SOURCE: stellar-docs "Configure Stellar CLI for Local Network" (verified 2026-06-02)
  LOCAL_RPC_URL=http://localhost:8000/rpc
  LOCAL_NETWORK_PASSPHRASE=Standalone Network ; February 2017
  LOCAL_FRIENDBOT_URL=http://localhost:8000/friendbot

  # ---- Stellar testnet — used when STELLAR_NETWORK=testnet ----
  # SOURCE: stellar-docs network config (verified 2026-06-02)
  TESTNET_RPC_URL=https://soroban-testnet.stellar.org
  TESTNET_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
  TESTNET_FRIENDBOT_URL=https://friendbot.stellar.org/

  # ---- Identity used by deploy scripts (stellar keys generate creates this) ----
  STELLAR_DEPLOYER=shadowkit-deployer

  # ---- Agent / LLM (M3) ----
  ANTHROPIC_API_KEY=

  # ---- Timelock / drand (M5) — quicknet defaults ----
  DRAND_CHAIN_URL=https://api.drand.sh
  DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971

  # ---- x402 (M6) ----
  X402_FACILITATOR_URL=
  X402_PAY_TO=
  ```
  > NOTE on the passphrase value containing `;` and spaces: bash `.env` parsers must read it as a literal string. The deploy script (Task 14) sources these via `set -a; . ./.env; set +a`, which preserves the literal value. The `DRAND_CHAIN_HASH` is the public drand quicknet chain hash (foundation §6 default network = quicknet); verify against `https://api.drand.sh/v2/chains` at M5.
- [ ] **12.2** Confirm `.gitignore` keeps `.env.example` (already present: `!.env.example`):
  ```bash
  cd /home/batuhan4/github/shadowKit && git check-ignore -v .env.example; echo "exit=$?"
  ```
  Expected: `exit=1` (NOT ignored — `git check-ignore` returns non-zero when the path is not ignored), confirming `.env.example` is trackable.
- [ ] **12.3** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add .env.example && \
  git commit -m "docs(repo): .env.example with local + testnet config

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 13 — `scripts/net-up.sh` + `net-down.sh` (local network)

**Files:** Create `scripts/net-up.sh`, `scripts/net-down.sh`.

> Verified commands (stellar-docs, 2026-06-02): `stellar network container start local`, `stellar network container logs local`, `stellar network container stop local`. The script also registers the `local` CLI network so later `--network local` works (stellar-docs "Configure Stellar CLI for Local Network": rpc-url `http://localhost:8000/rpc`, passphrase `Standalone Network ; February 2017`).

- [ ] **13.1** Create `scripts/net-up.sh`:
  ```bash
  #!/usr/bin/env bash
  # scripts/net-up.sh — start the local Stellar quickstart network (Docker) and register the CLI net.
  # SOURCE: stellar-docs "Start Local Stellar Network" + "Configure Stellar CLI for Local Network"
  #         (verified 2026-06-02).
  set -euo pipefail

  echo "[net-up] starting local Stellar quickstart container..."
  stellar network container start local

  echo "[net-up] registering 'local' network with the CLI..."
  stellar network add local \
    --rpc-url "http://localhost:8000/rpc" \
    --network-passphrase "Standalone Network ; February 2017" \
    --overwrite || \
  stellar network add local \
    --rpc-url "http://localhost:8000/rpc" \
    --network-passphrase "Standalone Network ; February 2017"

  echo "[net-up] waiting for RPC to become healthy..."
  for i in $(seq 1 60); do
    if curl -s -X POST "http://localhost:8000/rpc" \
         -H 'Content-Type: application/json' \
         -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"status":"healthy"'; then
      echo "[net-up] RPC healthy."
      exit 0
    fi
    sleep 2
  done
  echo "[net-up] ERROR: RPC did not become healthy in time." >&2
  exit 1
  ```
  > The `--overwrite` flag is verified for `stellar network add` (stellar-docs bindings example uses `--overwrite`); the `|| <retry without flag>` guards CLI versions where the flag name differs, so the script is robust without an interactive prompt (user rule).
- [ ] **13.2** Create `scripts/net-down.sh`:
  ```bash
  #!/usr/bin/env bash
  # scripts/net-down.sh — stop the local Stellar quickstart network.
  # SOURCE: stellar-docs "Manage Stellar Network Container" (verified 2026-06-02).
  set -euo pipefail
  echo "[net-down] stopping local Stellar quickstart container..."
  stellar network container stop local
  echo "[net-down] stopped."
  ```
- [ ] **13.3** Make both executable:
  ```bash
  chmod +x /home/batuhan4/github/shadowKit/scripts/net-up.sh /home/batuhan4/github/shadowKit/scripts/net-down.sh
  ```
- [ ] **13.4** Lint the scripts (syntax check without running Docker):
  ```bash
  bash -n /home/batuhan4/github/shadowKit/scripts/net-up.sh && \
  bash -n /home/batuhan4/github/shadowKit/scripts/net-down.sh && echo "SYNTAX-OK"
  ```
  Expected: `SYNTAX-OK`.
- [ ] **13.5** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add scripts/net-up.sh scripts/net-down.sh && \
  git commit -m "build(repo): net-up/net-down scripts for local Stellar network

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 14 — `scripts/deploy-local.sh` (build + deploy hello + SAC tokens, network-parameterized)

**Files:** Create `scripts/deploy-local.sh`.

> This script is the single deploy path for BOTH local and testnet (the milestone's "config-selectable fallback" requirement). It reads `STELLAR_NETWORK` from env/`.env` and computes the CLI network name. It: (1) ensures a funded deployer identity, (2) builds wasm, (3) deploys hello-world, (4) wires SAC tokens — for the LOCAL network it deploys a SAC for the NATIVE asset (`--asset native`) and a custom USDC SAC; on testnet it only resolves the SAC id for `native`/existing assets (deploying a native SAC fails on testnet because it already exists — verified stellar-docs note "this operation will fail on testnet because a SAC for Lumens already exists"). All commands verified 2026-06-02 (stellar-docs).
>
> **Two robustness fixes baked in here:**
> 1. **Caller-set `STELLAR_NETWORK` must win over `.env`.** The justfile invokes `STELLAR_NETWORK=testnet ./scripts/deploy-local.sh`, but the script also sources `.env` (which sets `STELLAR_NETWORK=local`). If `.env` were sourced with `set -a; . ./.env` it would CLOBBER the caller's `testnet`, so `just deploy-testnet` would silently deploy to LOCAL. Fix: capture the caller-provided `STELLAR_NETWORK`/`STELLAR_DEPLOYER` BEFORE sourcing `.env`, and prefer the captured value (`${CALLER_NET:-${STELLAR_NETWORK:-local}}`).
> 2. **Funding must be robust independent of identity existence.** `stellar keys generate --fund` only funds at creation time and ERRORS if the identity already exists. Global identities persist across `net-down`/`net-up`, so on a SECOND `just net-up; just deploy` cycle the identity exists but its on-chain account was wiped by the network reset → `--fund` is skipped (error tolerated) → the account is unfunded → `contract deploy` fails for lack of funds. Fix: after `keys generate` (tolerate "exists"), ALWAYS fund the resolved ADDRESS via friendbot (`curl -X POST "$FRIENDBOT_URL?addr=$ADDR"`), tolerating "already funded". Verified idempotent-friendbot pattern: stellar-docs initialization.mdx ("This will fail if the account already exists, but it'll still be fine").
>
> Verified commands:
> - `stellar keys generate --global <name> --network <net> --fund`
> - `stellar keys address <name>`
> - friendbot funding: `curl --silent --show-error -X POST "<FRIENDBOT_URL>?addr=<G...address>"` (POST; tolerant of already-funded)
> - `stellar contract build`
> - `stellar contract deploy --wasm <path> --source-account <id> --network <net> --alias <alias>`
> - `stellar contract asset deploy --source-account <id> --network <net> --asset native` (local only)
> - `stellar contract id asset --source-account <id> --network <net> --asset <code:issuer>`

- [ ] **14.1** Create `scripts/deploy-local.sh`:
  ```bash
  #!/usr/bin/env bash
  # scripts/deploy-local.sh — build + deploy ShadowKit contracts and wire SAC tokens.
  # Parameterized by $STELLAR_NETWORK (local|testnet) — ONE code path, config switch only.
  # All `stellar` subcommands verified against stellar-docs 2026-06-02 (see foundation §6).
  set -euo pipefail

  # ---- capture caller-provided env BEFORE sourcing .env, so an explicit
  #      `STELLAR_NETWORK=testnet ./deploy-local.sh` is NOT clobbered by .env's STELLAR_NETWORK=local ----
  CALLER_NET="${STELLAR_NETWORK:-}"
  CALLER_DEPLOYER="${STELLAR_DEPLOYER:-}"

  # ---- load config (.env fills in anything the caller did not set) ----
  if [ -f ./.env ]; then set -a; . ./.env; set +a; fi

  # caller-set value wins; else .env value; else hardcoded default
  NET="${CALLER_NET:-${STELLAR_NETWORK:-local}}"
  DEPLOYER="${CALLER_DEPLOYER:-${STELLAR_DEPLOYER:-shadowkit-deployer}}"
  echo "[deploy] network=${NET} deployer=${DEPLOYER}"

  # ---- pick the friendbot URL for this network (from .env; sane fallbacks) ----
  if [ "${NET}" = "local" ]; then
    FRIENDBOT_URL="${LOCAL_FRIENDBOT_URL:-http://localhost:8000/friendbot}"
  else
    FRIENDBOT_URL="${TESTNET_FRIENDBOT_URL:-https://friendbot.stellar.org/}"
  fi

  # ---- ensure the deployer identity EXISTS (tolerate "already exists") ----
  # `--fund` only funds at creation; we do robust funding separately below so a pre-existing
  # identity on a freshly-reset network still ends up funded.
  stellar keys generate --global "${DEPLOYER}" --network "${NET}" --fund \
    || echo "[deploy] identity ${DEPLOYER} already exists (continuing)"

  # ---- ALWAYS fund the resolved address via friendbot (idempotent; tolerate already-funded) ----
  # Robust across net-down/net-up: global keys persist but the on-chain account is wiped on reset.
  DEPLOYER_ADDR="$(stellar keys address "${DEPLOYER}")"
  echo "[deploy] funding ${DEPLOYER_ADDR} via friendbot (${FRIENDBOT_URL})..."
  curl --silent --show-error -X POST "${FRIENDBOT_URL}?addr=${DEPLOYER_ADDR}" >/dev/null \
    || echo "[deploy] friendbot fund returned non-zero (likely already funded) — continuing"

  # ---- build all contracts to wasm ----
  echo "[deploy] building contracts..."
  stellar contract build

  HELLO_WASM="target/wasm32v1-none/release/hello_world.wasm"
  test -f "${HELLO_WASM}" || { echo "[deploy] ERROR: ${HELLO_WASM} not found" >&2; exit 1; }

  # ---- deploy the hello-world pipeline-proof contract ----
  echo "[deploy] deploying hello-world..."
  HELLO_ID=$(stellar contract deploy \
    --wasm "${HELLO_WASM}" \
    --source-account "${DEPLOYER}" \
    --network "${NET}" \
    --alias hello_world)
  echo "[deploy] hello_world contract id: ${HELLO_ID}"

  # ---- wire SAC tokens (USDC / XLM testnet) ----
  if [ "${NET}" = "local" ]; then
    echo "[deploy] deploying native (XLM) SAC on local..."
    XLM_SAC=$(stellar contract asset deploy \
      --source-account "${DEPLOYER}" \
      --network "${NET}" \
      --asset native)
    echo "[deploy] XLM SAC id: ${XLM_SAC}"

    echo "[deploy] deploying custom USDC SAC on local (issuer=${DEPLOYER_ADDR})..."
    USDC_SAC=$(stellar contract asset deploy \
      --source-account "${DEPLOYER}" \
      --network "${NET}" \
      --asset "USDC:${DEPLOYER_ADDR}")
    echo "[deploy] USDC SAC id: ${USDC_SAC}"
  else
    echo "[deploy] testnet: resolving existing SAC ids (native SAC already exists on testnet)..."
    XLM_SAC=$(stellar contract id asset \
      --source-account "${DEPLOYER}" \
      --network "${NET}" \
      --asset native)
    echo "[deploy] XLM SAC id (resolved): ${XLM_SAC}"
    echo "[deploy] testnet USDC: use the canonical testnet USDC issuer at M6; skipping custom issue here."
  fi

  echo "[deploy] DONE. hello_world=${HELLO_ID} xlm_sac=${XLM_SAC:-n/a}"
  ```
- [ ] **14.2** Make executable + syntax-check:
  ```bash
  chmod +x /home/batuhan4/github/shadowKit/scripts/deploy-local.sh && \
  bash -n /home/batuhan4/github/shadowKit/scripts/deploy-local.sh && echo "SYNTAX-OK"
  ```
  Expected: `SYNTAX-OK`.
- [ ] **14.3** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add scripts/deploy-local.sh && \
  git commit -m "build(repo): network-parameterized deploy script (hello + SAC tokens)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 15 — `scripts/snapshot-fixtures.sh` stub (M4)

**Files:** Create `scripts/snapshot-fixtures.sh`.

> foundation §1: regenerates circuit fixtures. The real implementation (circom compile + groth16 setup + sample proof) is M4. M0 ships a stub that errors clearly. This is the ONE intentional not-yet-implemented script; it is documented and is NOT invoked by `just test`.

- [ ] **15.1** Create `scripts/snapshot-fixtures.sh`:
  ```bash
  #!/usr/bin/env bash
  # scripts/snapshot-fixtures.sh — regenerate circuit fixtures (compile + groth16 setup + sample proof).
  # STUB: implemented in M4 (needs circom 2.2.1 + snarkjs). See docs/.../05-m4-zk-circuit.md.
  set -euo pipefail
  echo "snapshot-fixtures: implemented in M4 (circom + snarkjs). Not available in M0." >&2
  exit 1
  ```
- [ ] **15.2** Make executable + syntax-check:
  ```bash
  chmod +x /home/batuhan4/github/shadowKit/scripts/snapshot-fixtures.sh && \
  bash -n /home/batuhan4/github/shadowKit/scripts/snapshot-fixtures.sh && echo "SYNTAX-OK"
  ```
  Expected: `SYNTAX-OK`.
- [ ] **15.3** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add scripts/snapshot-fixtures.sh && \
  git commit -m "build(circuit): snapshot-fixtures.sh stub (impl in M4)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 16 — `justfile`: orchestrate all layers

**Files:** Create `justfile`.

> `just` recipe syntax verified (ctx7 `/casey/just`, 2026-06-02): recipes are `name:` followed by indented shell lines; `dep` recipes via `name: dep1 dep2`; comments with `#`; `set dotenv-load := true` exports `.env` into every recipe's environment. `just test` must run Rust + TS + (circuit no-op in M0). `just deploy` runs local deploy; `just deploy-testnet` runs deploy with `STELLAR_NETWORK=testnet`.
>
> **SINGLE SOURCE OF TRUTH for the deployer identity (fixes the e2e/deploy divergence).** `scripts/deploy-local.sh` derives the deployer from `.env` as `${STELLAR_DEPLOYER:-shadowkit-deployer}`. The previous justfile defined its OWN just-level `STELLAR_DEPLOYER := "shadowkit-deployer"` and used `{{STELLAR_DEPLOYER}}` in the `e2e` invoke — so if `.env` set a DIFFERENT `STELLAR_DEPLOYER`, the deploy created/funded/aliased under one identity while the invoke used another, breaking alias/source-account resolution. Fix: `set dotenv-load := true` loads `.env` into the recipe environment, and the `e2e` invoke uses the SAME shell expansion the script uses (`${STELLAR_DEPLOYER:-shadowkit-deployer}`). Both the script and the invoke now resolve identity from the one `.env` value — no second source of truth, no `{{...}}` just-level default to drift.
>
> **`just build` is real (fixes the broken `tsc -b`).** `build-ts` runs `npm run build`, which (per Task 5.1) typechecks every TS package with `tsc --noEmit -p <pkg>` — NOT `tsc -b` (there is no root `tsconfig.json`/project references, so `tsc -b` would error `TS5083`). `build` aggregates `build-contracts` (wasm) + `build-ts` (typecheck) + `web-build` (the rendered page the milestone Goal promises). Task 16.3a actually RUNS `just build` and pastes success output, so the recipe is covered, not merely declared.

- [ ] **16.1** Create `justfile`:
  ```just
  # justfile — orchestrate all ShadowKit layers (foundation §1, §7.2)
  # Verified `just` syntax via ctx7 /casey/just (2026-06-02).

  # Load .env into every recipe's environment so the deployer identity (and other config) has a
  # SINGLE source of truth shared by scripts/deploy-local.sh and the e2e invoke below.
  set dotenv-load := true

  # default: list recipes
  default:
      @just --list

  # ---- local network ----
  net-up:
      ./scripts/net-up.sh

  net-down:
      ./scripts/net-down.sh

  # ---- build (contracts wasm + TS typecheck + web rendered page) ----
  build: build-contracts build-ts web-build

  build-contracts:
      stellar contract build

  # NOTE: build-ts runs `npm run build`, which typechecks each TS package with `tsc --noEmit -p <pkg>`
  # (see root package.json, Task 5.1). It is NOT `tsc -b` — there is no root tsconfig/project refs,
  # so `tsc -b` would fail with `error TS5083: Cannot read file 'tsconfig.json'`.
  build-ts:
      npm run build

  web-build:
      npm run build --workspace web

  # ---- test (the single entrypoint — foundation §7.2) ----
  test: test-contracts test-ts circuit-test

  test-contracts:
      cargo test --workspace

  # fallback feature paths (foundation §7.2). In M0 these crates are stubs with no such features yet,
  # so the recipe builds them WITHOUT the flags; the flagged variants are added by M2 (handrolled)
  # and M4 (offchain-verify). Kept here as named recipes so later milestones only fill the body.
  test-contracts-fallbacks:
      @echo "fallback feature suites land in M2 (handrolled) / M4 (offchain-verify)"

  test-ts:
      npx vitest run

  web-test:
      npm run test --workspace web

  # circuit-test is a DOCUMENTED no-op until M4 (the circuit is milestone M4 / spec §11). It runs
  # circuits/vote's `test` script which prints an M4-deferral message and exits 0. It asserts nothing
  # and is explicitly whitelisted by the Task 21 no-cheating audit. Drop-in: M4 replaces the script body.
  circuit-test:
      npm run test --prefix circuits/vote

  # ---- deploy (local is default; testnet via the parameterized script) ----
  deploy:
      STELLAR_NETWORK=local ./scripts/deploy-local.sh

  deploy-testnet:
      STELLAR_NETWORK=testnet ./scripts/deploy-local.sh

  # ---- end-to-end (M0: net-up -> deploy -> invoke hello -> assert) ----
  # The invoke uses the SAME identity expansion as scripts/deploy-local.sh — `.env`'s STELLAR_DEPLOYER
  # (loaded via `set dotenv-load`), defaulting to shadowkit-deployer — so deploy and invoke never diverge.
  e2e: net-up
      STELLAR_NETWORK=local ./scripts/deploy-local.sh
      stellar contract invoke --id hello_world --source-account "${STELLAR_DEPLOYER:-shadowkit-deployer}" --network local -- hello --to RPC
  ```
  > `circuit-test` uses `npm run test --prefix circuits/vote` (not a workspace run) because `circuits/vote` is intentionally outside the npm workspace glob (Task 9 note). In M0 it is the documented no-op script returning 0. The `e2e` invoke reads `${STELLAR_DEPLOYER:-shadowkit-deployer}` from the recipe environment (`.env` via `set dotenv-load`), the identical expression `deploy-local.sh` uses, so there is exactly one source of truth for the deployer identity.
- [ ] **16.2** Verify `just` parses the file and lists recipes:
  ```bash
  cd /home/batuhan4/github/shadowKit && just --list 2>&1 | head -25
  ```
  Expected: a list including `build`, `build-contracts`, `build-ts`, `web-build`, `deploy`, `deploy-testnet`, `e2e`, `net-up`, `net-down`, `test`, `web-test`, `circuit-test`. No parse error.
- [ ] **16.3** Run `just test` (Rust + TS + circuit no-op) WITHOUT the network (does not need Docker):
  ```bash
  cd /home/batuhan4/github/shadowKit && just test 2>&1 | tail -25
  ```
  Expected: `cargo test --workspace` → hello-world `1 passed`, other crates `0 tests`, no failures; `vitest run` → `Tests  8 passed` (shared 6 + web 2, the `web` project under jsdom); `circuit-test` → `M4 — no circuit tests yet ...` exit 0. Overall `just test` exits 0.
- [ ] **16.3a** Run `just build` (this is the milestone Goal's `just build` — it MUST succeed end to end; no task previously exercised it). This compiles contracts to wasm, typechecks every TS package, and builds the web app to `dist/index.html`:
  ```bash
  cd /home/batuhan4/github/shadowKit && just build 2>&1 | tail -25
  ```
  Expected: `stellar contract build` finishes with `Finished \`release\` ...`; `npm run build` runs the seven `tsc --noEmit -p <pkg>` typechecks with no type errors; `npm run build --workspace web` ends with `[build] Complete!`. Overall `just build` exits 0. Then confirm the rendered page exists:
  ```bash
  grep -o "ShadowKit AgentBoard" /home/batuhan4/github/shadowKit/web/dist/index.html | head -1
  ```
  Expected: `ShadowKit AgentBoard`. If `just build` fails with `TS5083`, the root `build` script is wrong (it must be the per-package `tsc --noEmit -p` form from Task 5.1, NOT `tsc -b`).
- [ ] **16.4** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add justfile && \
  git commit -m "build(repo): justfile orchestrating build/test/deploy across layers

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 17 — Bring up the local network (integration; requires Docker)

**Files:** none (runs `just net-up`).

- [ ] **17.1** Confirm Docker is running (gate from Task 0.6):
  ```bash
  docker info >/dev/null 2>&1 && echo "docker-ok" || echo "docker-NOT-running"
  ```
  Expected: `docker-ok`. If not, start the daemon and re-run.
- [ ] **17.2** (integration) Start the local network:
  ```bash
  cd /home/batuhan4/github/shadowKit && just net-up 2>&1 | tail -15
  ```
  Expected: container starts, network registered, ends with `[net-up] RPC healthy.` (the script polls `getHealth` until `"status":"healthy"`).
- [ ] **17.3** Independently confirm RPC health:
  ```bash
  curl -s -X POST "http://localhost:8000/rpc" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
  ```
  Expected: JSON containing `"status":"healthy"`.
- [ ] **17.4** No commit (no file change). Leave the network running for Task 18.

---

## Task 18 — Deploy hello + SAC tokens to local net + invoke (PRIMARY pipeline proof)

**Files:** none (runs `just deploy` then invoke).

> This is the milestone's PRIMARY deliverable: build → deploy → invoke working end to end on the trivial contract, on the LOCAL network.

- [ ] **18.1** (integration) Run the local deploy:
  ```bash
  cd /home/batuhan4/github/shadowKit && just deploy 2>&1 | tail -20
  ```
  Expected: builds wasm; deploys hello-world printing `hello_world contract id: C...`; deploys XLM native SAC printing `XLM SAC id: C...`; deploys USDC SAC printing `USDC SAC id: C...`; ends with `[deploy] DONE. hello_world=C... xlm_sac=C...`.
- [ ] **18.2** (integration) Invoke the deployed contract by its alias:
  ```bash
  cd /home/batuhan4/github/shadowKit && stellar contract invoke \
    --id hello_world --source-account shadowkit-deployer --network local \
    -- hello --to RPC 2>&1 | tail -5
  ```
  Expected (verified invoke shape, stellar-docs): JSON array `["Hello","RPC"]`.
- [ ] **18.3** (integration) Confirm the XLM SAC responds (proves SAC wiring). Read the native SAC name via the deployed alias is not aliased, so query its `decimals` using the printed id from 18.1. Capture the id and invoke `decimals`:
  ```bash
  cd /home/batuhan4/github/shadowKit && XLM_SAC=$(stellar contract id asset --source-account shadowkit-deployer --network local --asset native) && \
  stellar contract invoke --id "$XLM_SAC" --source-account shadowkit-deployer --network local -- decimals 2>&1 | tail -3
  ```
  Expected: `7` (the native asset SAC has 7 decimals).
- [ ] **18.4** (integration — funding-robustness regression: SECOND net-up/deploy cycle). This proves the deploy-script funding fix (Task 14): the global identity `shadowkit-deployer` now ALREADY EXISTS, but tearing down and re-creating the local network WIPES its on-chain account. With the old `keys generate --fund || true` logic this second deploy would fail for lack of funds; with the friendbot re-funding step it must succeed. Reset the network and re-deploy:
  ```bash
  cd /home/batuhan4/github/shadowKit && just net-down 2>&1 | tail -3 && \
  just net-up 2>&1 | tail -3 && \
  just deploy 2>&1 | tail -20
  ```
  Expected: `net-down` stops the container; `net-up` brings up a fresh healthy RPC; `just deploy` prints `[deploy] identity shadowkit-deployer already exists (continuing)` THEN `[deploy] funding G... via friendbot (...)` and proceeds to a successful `[deploy] DONE. hello_world=C... xlm_sac=C...`. It MUST NOT fail with an underfunded/account-not-found error. Then re-invoke to confirm the freshly-deployed contract works:
  ```bash
  cd /home/batuhan4/github/shadowKit && stellar contract invoke \
    --id hello_world --source-account shadowkit-deployer --network local \
    -- hello --to RPC 2>&1 | tail -5
  ```
  Expected: `["Hello","RPC"]`. (If this step fails for lack of funds, the friendbot re-funding in Task 14 is broken — fix it before proceeding.)
- [ ] **18.5** No commit (no file change). The pipeline proof — including the two-cycle funding-robustness check — is recorded by the pasted outputs in the executing session.

---

## Task 19 — Testnet deploy path is real & exercised (config "fallback")

**Files:** none (runs `just deploy-testnet`, gated).

> The milestone requires BOTH local and testnet config to work and be documented. `just deploy-testnet` runs the SAME script with `STELLAR_NETWORK=testnet`. Because the script now captures the caller-provided `STELLAR_NETWORK` BEFORE sourcing `.env` (Task 14 fix), the `STELLAR_NETWORK=testnet` passed by the recipe wins over `.env`'s `STELLAR_NETWORK=local` — the deploy genuinely targets testnet (the previous code would have been clobbered back to local). Testnet requires a funded account: the script funds the deployer ADDRESS via the testnet friendbot (`TESTNET_FRIENDBOT_URL`, tolerant of already-funded) regardless of whether the identity is new or pre-existing. This task executes the REAL command path against testnet config. It is network-dependent (needs internet + testnet friendbot up); if testnet is unreachable in the run environment, the engineer MUST record the failure reason and re-run when reachable — it MUST NOT be silently skipped (charter rule 4).

- [ ] **19.1** Register the testnet network with the CLI (verified passphrase/rpc, stellar-docs 2026-06-02):
  ```bash
  stellar network add testnet \
    --rpc-url "https://soroban-testnet.stellar.org" \
    --network-passphrase "Test SDF Network ; September 2015" --overwrite 2>&1 | tail -2 || \
  stellar network add testnet \
    --rpc-url "https://soroban-testnet.stellar.org" \
    --network-passphrase "Test SDF Network ; September 2015"
  ```
  Expected: network added (or already present).
- [ ] **19.2** (integration, network-dependent) Run the testnet deploy:
  ```bash
  cd /home/batuhan4/github/shadowKit && just deploy-testnet 2>&1 | tail -20
  ```
  Expected: the FIRST line MUST read `[deploy] network=testnet deployer=shadowkit-deployer` (this is the proof the caller-set `STELLAR_NETWORK=testnet` won over `.env`'s `local` — if it says `network=local` the Task 14 override fix is broken); then funds `shadowkit-deployer` via the testnet friendbot; builds wasm; deploys hello-world to testnet printing a `C...` id; resolves the native SAC id on testnet (no native SAC deploy attempt — the script branches correctly); ends with `[deploy] DONE. hello_world=C... xlm_sac=C...`.
- [ ] **19.3** (integration) Invoke the testnet-deployed hello to confirm:
  ```bash
  cd /home/batuhan4/github/shadowKit && stellar contract invoke \
    --id hello_world --source-account shadowkit-deployer --network testnet \
    -- hello --to TESTNET 2>&1 | tail -5
  ```
  Expected: `["Hello","TESTNET"]`.
- [ ] **19.4** If testnet is unreachable: record the exact error (e.g. friendbot timeout) and the fact that the LOCAL path (Task 18) is fully green; do not mark the milestone complete until testnet has been exercised at least once and the result recorded. No code change is needed — the path is identical to local by construction. No commit.

---

## Task 20 — README quickstart (local + testnet documented)

**Files:** Create `README.md`.

> Milestone requires the config paths be documented. The README is the human entry point.

- [ ] **20.1** Create `README.md`:
  ```markdown
  # ShadowKit

  ZK- + AI-powered autonomous governance infrastructure for Stellar. See
  `docs/superpowers/specs/2026-06-02-shadowkit-design.md` (design) and
  `docs/superpowers/plans/00-foundation-interfaces.md` (binding interfaces).

  ## Prerequisites
  - Rust 1.94.1 (pinned via `rust-toolchain.toml`) + `wasm32v1-none` target
    (`rustup target add wasm32v1-none`).
  - `stellar` CLI: `cargo install --locked stellar-cli`.
  - `just`: `cargo install --locked just`.
  - Node 26 + npm (workspaces). `npm install` at the repo root.
  - Docker (for the local Stellar network).

  ## One-time setup
  ```bash
  rustup target add wasm32v1-none
  cargo install --locked stellar-cli just
  npm install
  cp .env.example .env   # then fill in keys as needed
  ```

  ## Build & test everything
  ```bash
  just build    # contracts -> wasm, typecheck every TS package, build web -> dist/index.html
  just test     # cargo test --workspace + vitest (TS shared + web under jsdom) + circuit (no-op until M4)
  ```
  > Vitest aggregates packages via the root `vitest.config.ts` `test.projects` (Vitest 4;
  > there is no `vitest.workspace.ts`). `just build` does NOT use `tsc -b` — it typechecks
  > each package with `tsc --noEmit -p <pkg>` (no root project references needed).

  ## Local network (Docker)
  ```bash
  just net-up        # start quickstart container + register 'local' network + wait for healthy RPC
  just deploy        # build wasm, deploy hello-world, deploy XLM + USDC SACs on local
  just e2e           # net-up + deploy + invoke hello (full local loop)
  just net-down      # stop the container
  ```

  ## Testnet
  Both local and testnet use the SAME deploy script, switched by `STELLAR_NETWORK`
  (no code fork). Network config lives in `.env.example` (passphrases verified
  against stellar-docs 2026-06-02).
  ```bash
  stellar network add testnet \
    --rpc-url "https://soroban-testnet.stellar.org" \
    --network-passphrase "Test SDF Network ; September 2015"
  just deploy-testnet   # funds deployer via friendbot, deploys hello-world to testnet
  ```

  ## Workspace layout
  See `docs/superpowers/plans/00-foundation-interfaces.md` §1. Rust contracts in
  `contracts/`, TS libs in `packages/`, agent in `agent/`, x402 in
  `x402-services/`, frontend in `web/`, circuit in `circuits/`.

  ## Milestones
  M0 (this) = scaffold + pipeline. M1–M6 build the product (foundation §9). The
  `hello-world` contract is a throwaway pipeline proof and is removed at M1.
  ```
- [ ] **20.2** Commit:
  ```bash
  cd /home/batuhan4/github/shadowKit && git add README.md && \
  git commit -m "docs(repo): README quickstart (local + testnet)

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 21 — No-cheating audit + full green gate

**Files:** none (verification).

> foundation §7.2 "No-cheating audit": grep for skip/ignore/always-pass patterns. Then run the entire `just test` once more as the final gate.
>
> **The ONE whitelisted no-op (documented).** `just test` aggregates `circuit-test`, which runs `circuits/vote`'s `test` script: `echo 'M4 — no circuit tests yet (circuit is milestone M4 / spec §11); deferred no-op' && exit 0`. This is an always-pass no-op (asserts nothing) and would normally be exactly the "assertion that always passes" the charter warns about. It is justified for M0 because the circuit is genuinely milestone M4 (spec §11) — there is no circuit to test yet — and it is explicitly whitelisted HERE with that same-line justification. Foundation §7.2 lists the circuit as a real test layer; that layer's real suite arrives in M4 (which replaces this script body). No OTHER no-op is permitted in `just test`.

- [ ] **21.1** Run the no-cheating grep across SOURCE files (must return no UNJUSTIFIED hits). Note: this grep targets `.rs`/`.ts`/`.tsx` test/source files — it does NOT scan `package.json` scripts (handled by 21.1a):
  ```bash
  cd /home/batuhan4/github/shadowKit && \
  grep -rnE '#\[ignore\]|\.skip\(|\.only\(|it\.todo|xfail|assert!\(true\)|expect\(true\)\.toBe\(true\)' \
    contracts packages agent x402-services web --include='*.rs' --include='*.ts' --include='*.tsx' 2>/dev/null; \
  echo "exit=$?"
  ```
  Expected: no matches; `exit=1` (grep returns 1 when nothing matches). If any line is printed, it MUST carry a same-line justification comment referencing the spec, else fix it before proceeding.
- [ ] **21.1a** Audit the always-pass `&& exit 0` no-op shape in package.json `test` scripts. Exactly ONE is permitted — the documented `circuits/vote` circuit-test no-op (M4 / spec §11). Confirm there is exactly one such script and that it is the whitelisted circuit one:
  ```bash
  cd /home/batuhan4/github/shadowKit && \
  grep -rn '"test":' circuits/vote/package.json packages */package.json agent/package.json x402-services/*/package.json web/package.json 2>/dev/null | grep 'exit 0'
  ```
  Expected: EXACTLY one line, and it MUST be `circuits/vote/package.json`'s `test` script whose message contains `M4 — no circuit tests yet`. Any OTHER `test` script that does `&& exit 0` (a fake-green no-op) is a cheat and must be removed/replaced. (The `packages/*`, `agent`, `x402-services/*`, `web` `test` scripts are all `vitest run`, which runs real tests or reports honest no-test results — they do NOT `exit 0` unconditionally.)
- [ ] **21.2** Confirm the deferred-impl stubs are clearly marked (they THROW, they don't fake success). Spot-check that every stub body either `throw`s or `exit 1`/`panic`s rather than silently returning a fake-OK value:
  ```bash
  cd /home/batuhan4/github/shadowKit && \
  grep -rn "implemented in M" packages agent x402-services scripts circuits 2>/dev/null | wc -l
  ```
  Expected: a count > 0 (every deferred stub carries an "implemented in Mx" marker). These are scaffolds with NO tests asserting success — they are not cheated tests.
- [ ] **21.3** Final gate — run the full local test suite (no Docker needed):
  ```bash
  cd /home/batuhan4/github/shadowKit && just test 2>&1 | tail -20
  ```
  Expected: `cargo test --workspace` all green (hello-world `1 passed`); `vitest run` `Tests  8 passed` (shared 6 + web 2); circuit no-op prints `M4 — no circuit tests yet ...` exit 0; `just test` exits 0.
- [ ] **21.4** Confirm the full workspace still builds for wasm (deploy readiness):
  ```bash
  cd /home/batuhan4/github/shadowKit && stellar contract build 2>&1 | tail -3 && \
  ls target/wasm32v1-none/release/hello_world.wasm
  ```
  Expected: `Finished \`release\`...` and the wasm path listed.
- [ ] **21.5** No commit (verification only). If `just net-up` was used, optionally `just net-down` to free Docker resources.

---

## Task 22 — Final review checkpoint

**Files:** none (review).

- [ ] **22.1** Verify every foundation §1 top-level path exists (the workspace shape is complete):
  ```bash
  cd /home/batuhan4/github/shadowKit && \
  for p in Cargo.toml Cargo.lock package.json tsconfig.base.json vitest.config.ts justfile \
           rust-toolchain.toml .env.example .gitignore README.md \
           contracts/shared/src/lib.rs contracts/groth16-verifier/src/lib.rs \
           contracts/gov-vault/src/lib.rs contracts/agent-policy/src/lib.rs \
           contracts/fallback-amm/src/lib.rs contracts/swap-venue/src/lib.rs \
           circuits/vote/package.json circuits/vote/fixtures/.gitkeep packages/shared/src/index.ts \
           packages/zk-prover/src/index.ts packages/snapshot-tool/src/index.ts \
           packages/tally-reveal/src/index.ts agent/src/index.ts \
           x402-services/premium-data/src/server.ts x402-services/shadowkit-api/src/server.ts \
           web/src/pages/index.astro web/src/components/Placeholder.tsx web/vitest.config.ts \
           scripts/net-up.sh scripts/net-down.sh scripts/deploy-local.sh scripts/snapshot-fixtures.sh; do
    test -e "$p" && echo "ok  $p" || echo "MISSING  $p"; done
  ```
  Expected: every line `ok ...`, none `MISSING`. (Note: there is NO `vitest.workspace.ts` — Vitest 4 uses the root `vitest.config.ts` with `test.projects`.)
- [ ] **22.2** Review git log for clean conventional commits:
  ```bash
  cd /home/batuhan4/github/shadowKit && git log --oneline m0-scaffold 2>&1 | head -25
  ```
  Expected: one commit per TDD cycle, all `type(scope): subject` form.
- [ ] **22.3** Milestone done-criteria checklist (all must be true):
  - [ ] `cargo test --workspace` green (Rust workspace compiles + hello test passes).
  - [ ] `npx vitest run` green via the root `vitest.config.ts` `test.projects` (TS: shared **6** + web **2** = **8 passed**; the `web` project runs under jsdom+react).
  - [ ] `just test` green end to end (Rust + TS + the ONE documented circuit no-op).
  - [ ] `just build` green end to end (contracts wasm + per-package `tsc --noEmit` typecheck + web `dist/index.html`) — Task 16.3a.
  - [ ] `just net-up` brings up a healthy local RPC (Docker).
  - [ ] `just deploy` builds wasm, deploys hello-world + XLM/USDC SACs locally, invoke returns `["Hello","RPC"]`.
  - [ ] A SECOND `net-down; net-up; deploy` cycle still succeeds (friendbot re-funding robustness — Task 18.4).
  - [ ] `just deploy-testnet` exercised against testnet (or failure recorded with reason; path identical by construction; first line shows `network=testnet`, proving the `.env`-override fix).
  - [ ] `web` builds (`npm run build --workspace web`) and the placeholder renders (render test passes + `dist/index.html` contains the title).
  - [ ] No unjustified skip/ignore/always-pass patterns (Task 21.1/21.1a); the single circuit no-op is documented + whitelisted.
  - [ ] `.gitignore` force-keeps `circuits/vote/fixtures/` (verified via plain `git check-ignore` + `git add -An`, Task 9.6).
  - [ ] Local + testnet config documented (`.env.example` + README).

> **STOP — review checkpoint.** Per `superpowers:executing-plans`, pause here for the user/reviewer to confirm M0 is complete before starting M1 (`02-m1-govvault-amm.md`). At M1, delete the throwaway `contracts/hello-world` crate (and remove it from `Cargo.toml` `members`) — it has served its pipeline-proof purpose.

---

## Appendix A — API verification provenance (2026-06-02)

Every external command/API used above was verified on 2026-06-02:

| API / command | Source (verified 2026-06-02) |
|---|---|
| `stellar network container start/logs/stop local` | stellar-docs (ctx7 `/stellar/stellar-docs`) "Start Local Stellar Network", "Manage Stellar Network Container" |
| `stellar network add <net> --rpc-url --network-passphrase [--overwrite]` | stellar-docs "Configure Stellar CLI for Local Network" + bindings example |
| `stellar keys generate --global <name> --network <net> --fund` | stellar-docs "Generate Stellar Identity" |
| `stellar contract build` → `target/wasm32v1-none/release/*.wasm` | stellar-docs "Contract Build and Upload" |
| `stellar contract deploy --wasm --source-account --network --alias` | stellar-docs "Deploy Smart Contract to Stellar Quickstart" |
| `stellar contract invoke --id <alias> --source-account --network -- <fn> --arg v` | stellar-docs "Invoke Smart Contract on Stellar Quickstart" |
| `stellar contract asset deploy --source-account --network --asset native\|CODE:ISSUER` | stellar-docs "Deploy Stellar Asset Contract using CLI" + "Deploy Native Lumens Asset Contract" (note: native SAC deploy FAILS on testnet — already exists) |
| `stellar contract id asset --source-account --network --asset ...` | stellar-docs SAC section |
| `stellar contract bindings typescript --network --id --output-dir --overwrite` | stellar-docs "Stellar Contract Bindings Generation" (used in later milestones) |
| local passphrase `Standalone Network ; February 2017`; testnet `Test SDF Network ; September 2015` | stellar-docs network config |
| hello_world `lib.rs` + `test.rs` (verbatim) | `raw.githubusercontent.com/stellar/soroban-examples/main/hello_world/src/{lib,test}.rs` |
| release profile (opt-level z, lto, panic abort, …) | `raw.githubusercontent.com/stellar/soroban-examples/main/workspace/Cargo.toml` |
| `soroban-sdk 26.0.0`, target `wasm32v1-none`, versions of astro/react/vitest | foundation §6 (each cited there) |
| `just` recipe/dependency/variable syntax | ctx7 `/casey/just` |

**Re-verification rule (foundation §6):** before changing any command above, re-run `npx ctx7@latest library "<name>" "<question>"` then `npx ctx7@latest docs "<id>" "<question>"`, or fetch the cited GitHub raw URL. Do not invent flags or subcommands.
