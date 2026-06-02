# 00 — Shared Foundation & Binding Interfaces

> **For agentic workers:** This is the **single source of truth** for ShadowKit. Every milestone plan (`01`-`07`, milestones **M0-M6**) MUST reference the exact crate names, file paths, function signatures, types, storage keys, events, error enums, and versions defined here. **These signatures are BINDING.** If a plan needs a signature not in this document, it must be added here first (and that change rippled to dependent plans). No plan may invent a type, function, package, or path that is not defined in some task or in this document.
>
> **REQUIRED SUB-SKILL for executing the milestone plans:** `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Project:** ShadowKit (ZK + AI autonomous governance SDK for Stellar) & AgentBoard (front-end). Demo product: ShadowDAO.
**Spec:** `docs/superpowers/specs/2026-06-02-shadowkit-design.md` (read it before any plan).
**Date:** 2026-06-02. **Target:** Build On Stellar Hackathon — IBW 2026 (Main + Hack Agentic + Hack Privacy).

---

## 0. How to read this document

Sections:

1. **Monorepo file structure** — every directory + key file, one-line responsibility.
2. **Rust / Soroban contract interfaces** — binding signatures, storage keys, events, errors.
3. **TypeScript module interfaces** — binding signatures + types.
4. **Circuit signal layout (Circom)** — public/private signals, constraints.
5. **Shared data types** — cross-layer types (Rust ↔ TS ↔ Circom).
6. **Toolchain & versions** — verified, with sources.
7. **Testing charter** — the user's hard rules, verbatim, expanded into per-layer conventions.
8. **Git / commit conventions.**

**Verification provenance.** Every external API in this document was verified on 2026-06-02 against current sources (cited inline). Sources used: `npx ctx7@latest` (Context7 docs for `/stellar/rs-soroban-sdk`, `/kalepail/smart-account-kit`, `/coinbase/x402`), GitHub `raw.githubusercontent.com` for `stellar/rs-soroban-sdk`, `stellar/soroban-examples` (`groth16_verifier`), `OpenZeppelin/stellar-contracts` (`packages/accounts`, `examples/multisig-smart-account`), `drand/tlock-js`, `drand/drand-client`, and `npm view` for npm package versions. When a signature is non-obvious, the implementing task MUST cite the source in a code comment.

---

## 1. Monorepo File Structure

ShadowKit is a **hybrid monorepo**: a single Cargo workspace for Rust contracts, an npm/pnpm workspace for TypeScript packages, a Circom directory, and a `justfile` orchestrating all layers. The spec's "Proposed workspace layout" (§8) is the authoritative top-level shape.

```
shadowkit/
├── Cargo.toml                         # Rust workspace root: [workspace] members = all contracts/* crates
├── Cargo.lock                         # committed (reproducible contract builds)
├── package.json                       # npm workspace root: "workspaces": ["packages/*","agent","x402-services/*","web"]
├── pnpm-workspace.yaml                # pnpm workspace globs (if pnpm chosen; see §6 — npm workspaces is the default)
├── tsconfig.base.json                 # shared TS compiler options (strict, ES2022, moduleResolution bundler)
├── vitest.config.ts                   # Vitest root config: `test.projects` aggregates every package as a project (Vitest 4; `defineWorkspace`/`vitest.workspace.ts` were REMOVED in v4 — verified ctx7 /vitest-dev/vitest v4.1.6, 2026-06-02)
├── justfile                           # `just test` / `just deploy` / `just build` / `just net-up` across ALL layers
├── rust-toolchain.toml                # pins Rust 1.94.1, targets wasm32v1-none (Soroban wasm target, P23+)
├── .env.example                       # template: RPC_URL, NETWORK_PASSPHRASE, ANTHROPIC_API_KEY, DRAND_*, x402 keys
├── .gitignore                         # (already present) ignores target/, node_modules/, *.zkey, *.wasm, secrets
│
├── contracts/                         # ---- RUST / SOROBAN (Cargo workspace members) ----
│   ├── shared/                        # crate `shadowkit-shared`: cross-contract types, error enums, storage-key enums
│   │   ├── Cargo.toml                 #   no-std lib crate, depends on soroban-sdk
│   │   └── src/lib.rs                 #   ActionSpec, ProposalStatus, ProposalView, SealedVote, QuorumCfg, shared errors
│   ├── groth16-verifier/              # crate `groth16-verifier`: on-chain Groth16 verify (BLS12-381)
│   │   ├── Cargo.toml                 #   crate-type = ["cdylib"]; soroban-sdk
│   │   └── src/
│   │       ├── lib.rs                 #   #[contract] Groth16Verifier; verify_proof(); VerificationKey; Proof
│   │       ├── vk.rs                  #   embedded VerificationKey constructor (from snarkjs verification_key.json)
│   │       └── test.rs                #   unit tests w/ committed fixtures (valid/tampered/malformed)
│   ├── gov-vault/                     # crate `gov-vault`: governance + sealed-vote storage + quorum + reveal
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                 #   #[contract] GovVault; all entrypoints (§2.2)
│   │       ├── storage.rs             #   DataKey enum + typed get/set helpers
│   │       ├── reveal.rs             #   close_and_reveal tally verification logic (M5)
│   │       └── test.rs                #   unit + negative tests
│   ├── agent-policy/                  # crate `agent-policy`: OZ Smart Account custom policy = treasury wallet (the lock)
│   │   ├── Cargo.toml                 #   depends on stellar-accounts 0.7.1 (OZ Smart Accounts crate)
│   │   └── src/
│   │       ├── lib.rs                 #   #[contract] AgentPolicy; impl Policy (OZ trait); init/config
│   │       ├── policy.rs              #   enforce() body: gate swap vs GovVault.is_approved + cap + target + asset
│   │       ├── fallback.rs            #   hand-rolled CustomAccountInterface __check_auth variant (feature = "handrolled")
│   │       └── test.rs                #   real-auth tests: allow + 7 reject cases (§7)
│   ├── fallback-amm/                  # crate `fallback-amm`: constant-product USDC/XLM pool implementing SwapVenue
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                 #   #[contract] FallbackAMM; swap/add_liquidity/reserves
│   │       └── test.rs
│   └── swap-venue/                    # crate `swap-venue`: SwapVenue trait + #[contractclient] + Soroswap adapter
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                 #   trait SwapVenue (Soroban contract client interface)
│           └── soroswap_adapter.rs    #   wraps Soroswap router to satisfy SwapVenue (M6; config-switched)
│
├── circuits/                          # ---- CIRCOM ----
│   └── vote/
│       ├── vote.circom                #   main circuit: membership + hidden weight + nullifier + sealed-vote well-formedness
│       ├── poseidon.circom            #   re-exports circomlib Poseidon (leaf + nullifier hashing)
│       ├── merkle.circom              #   MerkleTreeChecker(depth) inclusion proof
│       ├── package.json               #   scripts: compile, setup (groth16), export-vk, gen-witness, prove, verify
│       └── fixtures/                  #   COMMITTED: vote.r1cs, vote_final.zkey, verification_key.json, sample proof+signals
│           ├── verification_key.json  #   snarkjs VK (source for groth16-verifier/src/vk.rs)
│           ├── proof.json             #   sample valid proof (test fixture)
│           ├── public.json            #   sample public signals
│           └── input.json             #   sample circuit input (private+public)
│
├── packages/                          # ---- TYPESCRIPT LIBRARIES ----
│   ├── shared/                        # pkg `@shadowkit/shared`: cross-layer TS types + contract bindings
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts               #   re-exports
│   │       ├── types.ts               #   ProposalView, ActionSpec, AgentLog, SealedVoteCiphertext, PublicSignals (§5)
│   │       └── bindings/              #   generated `stellar contract bindings typescript` output (GovVault, AgentPolicy, ...)
│   ├── zk-prover/                     # pkg `@shadowkit/zk-prover`: browser+node proof generation + timelock seal
│   │   ├── package.json               #   deps: snarkjs, ffjavascript, tlock-js, drand-client (NOT poseidon-lite — BN254; M4 §0.1 uses circuit wasm); devDep tsx (script runner)
│   │   └── src/
│   │       ├── index.ts               #   generateVoteProof(), verifyVoteProof(), nullifierFor()
│   │       ├── seal.ts                #   timelockSealVote() / timelockUnsealVote() (tlock-js wrappers)
│   │       ├── coordinator.ts         #   verifyAndAuthorize() — off-chain-verify fallback (§2.1/§3.2)
│   │       └── poseidon.ts            #   poseidonHashBls() via BLS12-381 circuit wasm — see §6 NOTE / M4 §0.1 (NOT poseidon-lite/BN254)
│   ├── snapshot-tool/                 # pkg `@shadowkit/snapshot-tool`: Merkle snapshot of eligible holders
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts               #   buildSnapshot(), Snapshot.getPath(), Snapshot.root
│   │       └── merkle.ts              #   Poseidon Merkle tree (matches circuits/vote/merkle.circom depth)
│   └── tally-reveal/                  # pkg `@shadowkit/tally-reveal`: decrypt sealed votes + build reveal for close
│       ├── package.json
│       └── src/
│           ├── index.ts               #   revealTally(), buildRevealArgs()
│           └── drand.ts               #   beacon fetch + round↔deadline mapping (drand-client)
│
├── agent/                             # ---- AGENT MIDDLEWARE (TypeScript) ----
│   ├── package.json                   #   pkg `@shadowkit/agent`; deps: @stellar/stellar-sdk, @anthropic-ai/sdk, x402 client
│   └── src/
│       ├── index.ts                   #   AgentRunner orchestrator (wires the 5 modules)
│       ├── watcher.ts                 #   Watcher: poll RPC for proposal-closed events → emit trigger
│       ├── tallyReveal.ts             #   thin wrapper over @shadowkit/tally-reveal for the agent context
│       ├── dataClient.ts              #   DataClient: x402-pay premium-data endpoint, returns price/signal
│       ├── planner.ts                 #   Planner: Claude call → ActionPlan (≤ cap), with deterministic fallback
│       ├── executor.ts                #   Executor: build+sign (session key) swap tx via AgentPolicy, client cap guard
│       └── logBus.ts                  #   LogBus: typed AgentLog event emitter (SSE/WebSocket source for terminal)
│
├── x402-services/                     # ---- x402 SERVICES (TypeScript, Express) ----  (workspace glob "x402-services/*")
│   ├── shared-x402/                   # pkg `@shadowkit/x402-shared`: DRY x402 server-construction + local test facilitator + payer fetch
│   │   ├── package.json               #   deps: @x402/express, @x402/stellar, @x402/core, @x402/server, @x402/fetch, @stellar/stellar-sdk, express
│   │   └── src/
│   │       ├── index.ts               #   buildStellarResourceServer(cfg), startTestFacilitator(cfg) (REAL x402Facilitator + createFacilitatorRouter)
│   │       └── payerFetch.ts          #   makeX402Fetch(signerSecret, network) — client-side auto-paying fetch (agent + tests)
│   ├── premium-data/                  # pkg `@shadowkit/x402-premium-data`: x402-protected price+signal (agent PAYS)
│   │   ├── package.json               #   deps: express, @shadowkit/x402-shared (NOT unscoped x402-express — that has no Stellar support, §3.6)
│   │   └── src/
│   │       ├── server.ts              #   createPremiumDataServer(cfg): GET /market/:pair behind paymentMiddleware
│   │       ├── market.ts              #   pure marketDataFor(pair) -> { pair, price, signal }
│   │       └── main.ts                #   runnable entrypoint (reads env, app.listen) for the demo
│   └── shadowkit-api/                 # pkg `@shadowkit/x402-api`: x402-protected verify/execute (ShadowKit SELLS)
│       ├── package.json
│       └── src/
│           ├── server.ts              #   createShadowKitApiServer(cfg): POST /verify, POST /execute behind paymentMiddleware; reads GovVault
│           ├── gating.ts              #   assertApproved(proposalId, readApproved) provider gate
│           └── main.ts                #   runnable entrypoint (reads env, app.listen) for the demo
│
├── web/                               # ---- FRONTEND: AgentBoard (Astro + React) ----
│   ├── package.json                   #   deps: astro, @astrojs/react, react, @stellar/stellar-sdk, smart-account-kit, @shadowkit/zk-prover, @shadowkit/snapshot-tool, @shadowkit/shared
│   ├── astro.config.mjs               #   @astrojs/react integration; vite build target es2020 (tlock-js req, §6)
│   ├── tsconfig.json
│   └── src/
│       ├── pages/index.astro          #   AgentBoard shell page
│       ├── lib/contracts.ts           #   typed contract clients (from @shadowkit/shared/bindings)
│       ├── lib/wallet.ts              #   smart-account-kit SmartAccountKit init + connect (passkey/keypair)
│       └── components/                #   React islands (one file each):
│           ├── ConnectBar.tsx         #   connect via smart-account-kit
│           ├── ProposalList.tsx       #   render ProposalView[]
│           ├── VoteModal.tsx          #   build proof + timelock-seal + submit cast_vote
│           ├── SealedTallyPanel.tsx   #   countdown + "N votes cast, results hidden" — NEVER shows tally pre-close
│           ├── RevealedResult.tsx     #   weighted tally, post-close only
│           ├── AgentBoardTerminal.tsx #   streams AgentLog from logBus
│           └── TreasuryPanel.tsx      #   treasury balances (AgentPolicy wallet)
│
├── docs/
│   └── superpowers/
│       ├── specs/2026-06-02-shadowkit-design.md
│       └── plans/                     # 00-foundation-interfaces.md (THIS FILE) + 01..07 milestone plans
│
└── scripts/                           # cross-layer dev scripts invoked by justfile
    ├── net-up.sh                      #   start `stellar` quickstart container (local network)
    ├── deploy-local.sh                #   build wasm + deploy all contracts + create SAC tokens
    ├── snapshot-fixtures.sh           #   regenerate circuit fixtures (compile+setup+sample proof)
    ├── deploy-testnet.sh              #   (M6) build wasm + deploy all contracts to testnet + SAC + init + write .env.testnet
    ├── x402-bootstrap.ts              #   (M6) provision 3 x402 keypairs, Friendbot-fund, add USDC trustlines, fund payer USDC; writes .env.x402
    ├── demo.sh                        #   (M6) full e2e demo loop runner; --network local|testnet
    └── demo/                          #   (M6) demo step helpers (each ≤40 lines, reuse M1–M5 code)
        ├── _env.ts                    #     loads .env.{local,testnet} + exports typed ids/urls
        ├── create-proposal.ts        #     buildSnapshot + GovVault.create_proposal(--deadline)
        ├── cast-votes.ts             #     generateVoteProof + timelock-seal + GovVault.cast_vote ×N
        ├── assert-sealed.ts          #     reads ProposalView; exit 1 if weighted_* != null pre-close
        ├── reveal.ts                 #     buildRevealArgs + GovVault.close_and_reveal at deadline
        ├── run-agent.ts              #     AgentRunner.run (x402 pay → plan → sign → swap); snapshots treasury bal
        └── assert-final.ts          #     exit 1 unless treasury balance changed AND tally revealed
```

**Crate names (Cargo):** `shadowkit-shared`, `groth16-verifier`, `gov-vault`, `agent-policy`, `fallback-amm`, `swap-venue`.
**npm package names:** `@shadowkit/shared`, `@shadowkit/zk-prover`, `@shadowkit/snapshot-tool`, `@shadowkit/tally-reveal`, `@shadowkit/agent`, `@shadowkit/x402-shared`, `@shadowkit/x402-premium-data`, `@shadowkit/x402-api`, and `web` (private, unpublished).
**npm workspaces glob (root `package.json`):** `["packages/*","agent","x402-services/*","web"]` — the `x402-services/*` glob matches `shared-x402`, `premium-data`, and `shadowkit-api`. (Confirm this glob in M0's root `package.json` before the M6 scaffold; if absent, add `x402-services/*` first.)

---

## 2. Rust / Soroban Contract Interfaces (BINDING)

> **General Soroban conventions** (verified via ctx7 `/stellar/rs-soroban-sdk` + `stellar/soroban-examples`):
> - Contract type: `#[contract] pub struct Name;`, impl block `#[contractimpl]`.
> - Custom types: `#[contracttype] #[derive(Clone, Debug, PartialEq)]`.
> - Errors: `#[contracterror] #[derive(Copy, Clone, ...)] #[repr(u32)] pub enum E { Variant = 1, ... }`.
> - Events: `#[contractevent] #[derive(Clone, Debug, Eq, PartialEq)] pub struct Ev { #[topic] pub a: ..., pub b: ... }`, published via `Ev { .. }.publish(&env);`.
> - Storage: `env.storage().instance()` / `.persistent()` / `.temporary()`, keyed by a `#[contracttype]` enum.
> - Auth: `addr.require_auth();`. Crypto: `env.crypto().sha256(&bytes)`, `env.crypto().bls12_381()`.
> - Soroban entrypoints take `env: Env` (or `e: &Env` for OZ-style) as the first parameter.

### 2.1 `groth16-verifier` (crate `groth16-verifier`)

Adapted from `stellar/soroban-examples/groth16_verifier` (demo-grade, unaudited; disclosed). **Verified signature** from `groth16_verifier/src/lib.rs` (raw GitHub, 2026-06-02).

```rust
// contracts/groth16-verifier/src/lib.rs
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine}, // soroban_sdk::crypto::bls12_381 owns these types
    vec, Env, Vec,
};

// BINDING re-export: soroban-sdk's bls12-381 module does NOT name the scalar field `Bls12381Fr`
// (it is `Fr`), and the reference verifier does NOT re-export it. gov-vault (§2.2) and §5 refer to
// `groth16_verifier::Bls12381Fr`, so this crate MUST re-export the scalar field under that name.
// Verified 2026-06-02: stellar/soroban-examples groth16_verifier imports `Fr` directly from
// soroban_sdk::crypto::bls12_381 and adds no re-export — ShadowKit adds the line below so the
// path `groth16_verifier::Bls12381Fr` resolves for downstream crates.
pub use soroban_sdk::crypto::bls12_381::Fr as Bls12381Fr;

#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: G1Affine,    // vk.alpha_1
    pub beta:  G2Affine,    // vk.beta_2
    pub gamma: G2Affine,    // vk.gamma_2
    pub delta: G2Affine,    // vk.delta_2
    pub ic:    Vec<G1Affine>, // vk.IC — length = (#public signals) + 1
}

#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: G1Affine,   // pi_a (G1)
    pub b: G2Affine,   // pi_b (G2)
    pub c: G1Affine,   // pi_c (G1)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Groth16Error {
    // BINDING discriminant. Matches the reference verifier EXACTLY:
    // stellar/soroban-examples groth16_verifier/src/lib.rs defines `MalformedVerifyingKey = 0`
    // (verified raw GitHub 2026-06-02). The discriminant is part of the contract error ABI —
    // tests and generated bindings match on the u32 code, so it MUST stay 0.
    MalformedVerifyingKey = 0, // pub_signals.len() + 1 != vk.ic.len()
}

#[contract]
pub struct Groth16Verifier;

#[contractimpl]
impl Groth16Verifier {
    /// Pure verification: e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1.
    /// vk_x = ic[0] + Σ pub_signals[i]·ic[i+1]. Returns Ok(true) iff the proof is valid.
    /// SOURCE: stellar/soroban-examples groth16_verifier/src/lib.rs (BLS12-381 host fns).
    pub fn verify_proof(
        env: Env,
        vk: VerificationKey,
        proof: Proof,
        pub_signals: Vec<Fr>,
    ) -> Result<bool, Groth16Error>;

    /// Convenience entrypoint used by GovVault: loads the EMBEDDED VK (vk.rs) and verifies.
    /// pub_signals order is BINDING: [merkleRoot, nullifier, proposalId, sealedCommitmentHash] (§4).
    pub fn verify(env: Env, proof: Proof, pub_signals: Vec<Fr>) -> bool;

    /// FALLBACK-2 entrypoint (M4 degraded `vote_min` circuit): loads the EMBEDDED min VK (vk_min.rs)
    /// for 3 public signals. Order BINDING: [merkleRoot, nullifier, proposalId]. Used by
    /// `gov-vault::cast_vote_min` under `feature = "circuit-min"`. (Added in M4; the verifier exposes both
    /// `verify` and `verify_min` unconditionally; gov-vault selects under its own feature.)
    pub fn verify_min(env: Env, proof: Proof, pub_signals: Vec<Fr>) -> bool;
}
```

- **Embedded VK:** `contracts/groth16-verifier/src/vk.rs` exposes `pub fn embedded_vk(env: &Env) -> VerificationKey` built from `circuits/vote/fixtures/verification_key.json`.
- **Storage:** none (stateless verifier; VK is compiled in).
- **Events:** none.
- **Fallback (off-chain verify, M4):** When `gov-vault` is built with feature `offchain-verify`, `cast_vote` takes an EXTRA trailing `verified: bool` parameter (a cfg-gated argument; the PRIMARY build omits it) asserted by a trusted coordinator instead of calling `verify`. The contract still requires the coordinator/admin auth AND rejects `verified == false` (→ `GovError::InvalidProof`). The coordinator that sets the flag runs the REAL `snarkjs.groth16.verify` off-chain via `@shadowkit/zk-prover`'s `verifyAndAuthorize(vkey, publicSignals, proof) -> { verified: boolean }` (`packages/zk-prover/src/coordinator.ts`) and MUST refuse to authorize any proof that does not verify — so the off-chain verification is real, tested code, not an unverified escape hatch (charter rule 3). The verifier crate is unchanged; the switch lives in `gov-vault` (§2.2). **The off-chain build therefore exposes a DIFFERENT `cast_vote` ABI** (5 args + `verified`) from the primary build (5 args); this divergence is intentional and confined to the trusted-coordinator deployment.

`Fr` public-signal encoding: each public signal is a `Fr` (= the re-exported `groth16_verifier::Bls12381Fr`, the BLS scalar field, `U256`-backed). snarkjs emits decimal strings in `public.json`; the TS binding converts each to a 32-byte big-endian scalar for `Vec<Fr>` (see §3 `@shadowkit/shared`). **Naming:** inside `groth16-verifier` the type is `Fr`; cross-crate (gov-vault §2.2, §5) it is referenced as `groth16_verifier::Bls12381Fr` via the `pub use` re-export above. The two names denote the SAME `soroban_sdk::crypto::bls12_381::Fr` type.

### 2.2 `gov-vault` (crate `gov-vault`)

Holds NO funds. Stores sealed votes, exposes no tally before close. Spec §8.

```rust
// contracts/gov-vault/src/lib.rs
use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype,
    Address, BytesN, Env, Symbol, Vec};
use shadowkit_shared::{ActionSpec, ProposalView, ProposalStatus, QuorumCfg, SealedVote, VoteDecryption};
use crate::storage::DataKey;

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
    DeadlinePassed     = 5,   // cast_vote after deadline
    DeadlineNotReached = 6,   // close_and_reveal before deadline
    NullifierUsed      = 7,   // double-vote
    WrongProposalId    = 8,   // nullifier/proof bound to a different proposalId (replay)
    InvalidProof       = 9,   // groth16 verify returned false
    StaleMerkleRoot    = 10,  // public merkleRoot signal != stored root
    AlreadyRevealed    = 11,
    NotRevealed        = 12,
    RevealMismatch     = 13,  // reveal proof / aggregate inconsistent with sealed votes
    AlreadyExecuted    = 14,
    NotApproved        = 15,
}

#[contractimpl]
impl GovVault {
    /// Initialize once. quorum_cfg default: min_voters=3, yes_must_exceed_no=true (§5).
    pub fn init(
        env: Env,
        admin: Address,
        verifier: Address,        // Groth16Verifier contract id
        merkle_root: BytesN<32>,  // snapshot root (Poseidon, big-endian 32 bytes)
        treasury_asset: Address,  // SAC address of the treasury asset (e.g. USDC)
        quorum_cfg: QuorumCfg,
    );

    /// Create a proposal. Returns the new proposal id (sequential u32, starts at 0).
    /// `cap` bounds ActionSpec.amount; `deadline` is a ledger-time unix timestamp (u64 seconds).
    pub fn create_proposal(
        env: Env,
        action_spec: ActionSpec,
        cap: i128,
        deadline: u64,
    ) -> u32;

    /// Cast a SEALED vote. Verifies the proof, checks nullifier+proposalId binding+merkleRoot,
    /// stores the sealed ciphertext. EXPOSES NO TALLY. `pub_signals` order per §4.
    /// Feature `offchain-verify` (fallback): skips on-chain verify; the entrypoint instead takes an
    /// EXTRA trailing `verified: bool` flag (foundation §2.1) set by a trusted coordinator that ran
    /// the REAL `snarkjs.groth16.verify` off-chain, AND still requires the coordinator/admin auth and
    /// rejects `verified == false`. The two builds expose two ABIs (5 args primary; 6 args offchain).
    pub fn cast_vote(
        env: Env,
        id: u32,
        proof: groth16_verifier::Proof,         // re-exported type
        pub_signals: Vec<groth16_verifier::Bls12381Fr>, // [merkleRoot, nullifier, proposalId, sealedCommitmentHash]
        sealed_ciphertext: SealedVote,          // tlock-encrypted (direction,weight) blob (§5)
        // #[cfg(feature = "offchain-verify")] verified: bool,  // trusted-coordinator off-chain-verify result
    );

    /// After deadline: verify the revealed weighted aggregate against stored sealed votes,
    /// set yes/no weight, decide pass/fail, set status Approved|Rejected. Single reveal only.
    /// `decryptions` carries ONE `VoteDecryption` per stored sealed vote (same length & order as
    /// `DataKey::SealedVotes(id)`), each being the tlock-decrypted (direction, weight) plus the
    /// sealed_commitment_hash that binds it to its on-chain ciphertext.
    /// RE-AGGREGATION CHECK (yields GovError::RevealMismatch on any failure):
    ///   (1) decryptions.len() == sealed_votes.len();
    ///   (2) for each i: decryptions[i].sealed_commitment_hash == sealed_votes[i].sealed_commitment_hash
    ///       (binds each decryption to the exact stored ciphertext — no substitution);
    ///   (3) direction[i] in {0,1};
    ///   (4) Σ weight[i] where direction[i]==1  == revealed_yes_w  AND
    ///       Σ weight[i] where direction[i]==0  == revealed_no_w   (recomputed on-chain).
    /// The chain does NOT itself run tlock decryption; it re-aggregates the SUBMITTED decryptions and
    /// rejects any aggregate inconsistent with the committed ciphertexts (see §3.4 buildRevealArgs and
    /// §13 fallback ladder). M5 PRIMARY must pass this check with REAL tlock-decrypted votes.
    pub fn close_and_reveal(
        env: Env,
        id: u32,
        revealed_yes_w: i128,
        revealed_no_w: i128,
        decryptions: Vec<VoteDecryption>,  // §2.6; one per sealed vote, same order
    );

    /// True iff proposal status == Approved (read by AgentPolicy during auth). View; no auth.
    pub fn is_approved(env: Env, id: u32) -> bool;

    /// Approved-proposal spending cap (read by AgentPolicy). Panics ProposalNotFound if absent.
    pub fn cap_of(env: Env, id: u32) -> i128;

    /// The approved ActionSpec (read by AgentPolicy to check target/asset). 
    pub fn action_of(env: Env, id: u32) -> ActionSpec;

    /// Full read model. weighted_yes/weighted_no are None until revealed. NEVER leaks tally early.
    pub fn proposal(env: Env, id: u32) -> ProposalView;

    /// Configure the authorized executor (the AgentPolicy smart-account wallet address) permitted to
    /// call `mark_executed`. Admin-auth (`admin.require_auth()`). Stored at `DataKey::Executor`. Idempotent
    /// (admin may re-point it). Set after AgentPolicy is deployed (M2 wires this in the deploy/config flow).
    /// This is the "configured AgentPolicy address" referenced by `mark_executed`'s auth gate.
    pub fn set_executor(env: Env, executor: Address);

    /// Single-shot replay guard: mark proposal Executed. Requires status==Approved & not executed.
    /// Auth: ONLY callable by the configured executor (the AgentPolicy address set via `set_executor`):
    /// reads `DataKey::Executor` and `executor.require_auth()`. A non-executor caller is rejected
    /// (`GovError::NotApproved` is NOT the auth error — auth failure surfaces as the host auth rejection;
    /// the negative test asserts a non-executor caller cannot mark). Sets status -> Executed.
    pub fn mark_executed(env: Env, id: u32);

    /// Number of sealed votes cast (participation; safe to expose — no direction).
    pub fn votes_cast(env: Env, id: u32) -> u32;

    /// FALLBACK-2 (M4, `feature = "circuit-min"`): cast a vote proved by the DEGRADED `vote_min` circuit
    /// (3 public signals [merkleRoot, nullifier, proposalId]; no sealed-commitment check). 1-person-1-vote
    /// — each accepted vote counts as weight 1 at reveal. Keeps the deadline + nullifier (double-vote) +
    /// proposalId (replay) + stale-root guards. Verifies via `Groth16Verifier::verify_min`. Only present
    /// when built with `circuit-min`.
    pub fn cast_vote_min(
        env: Env,
        id: u32,
        proof: groth16_verifier::Proof,
        pub_signals: Vec<groth16_verifier::Bls12381Fr>, // [merkleRoot, nullifier, proposalId]
        sealed_ciphertext: SealedVote,
    );
}
```

**Storage keys** (`contracts/gov-vault/src/storage.rs`):

```rust
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,                 // Address                (instance)
    Verifier,              // Address                (instance)
    MerkleRoot,            // BytesN<32>             (instance)
    TreasuryAsset,         // Address                (instance)
    QuorumCfg,             // QuorumCfg              (instance)
    Executor,              // Address  (AgentPolicy id; set via set_executor; auth for mark_executed) (instance)
    NextId,                // u32                    (instance)
    Proposal(u32),         // ProposalRecord         (persistent)
    SealedVotes(u32),      // Vec<SealedVote>        (persistent)
    Nullifier(BytesN<32>), // () (presence = used)   (persistent)
}
```

`ProposalRecord` (internal, persistent) carries: `action_spec, cap, deadline, status, weighted_yes: Option<i128>, weighted_no: Option<i128>, executed: bool`. `proposal()` projects it into `ProposalView` (§5).

**Events** (`#[contractevent]`):

```rust
#[contractevent] #[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreated { #[topic] pub id: u32, pub deadline: u64, pub cap: i128 }

#[contractevent] #[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteCast { #[topic] pub id: u32, pub nullifier: BytesN<32> } // no direction/weight

#[contractevent] #[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalClosed { #[topic] pub id: u32, pub approved: bool, pub weighted_yes: i128, pub weighted_no: i128 }

#[contractevent] #[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecuted { #[topic] pub id: u32 }
```

`ProposalClosed` is the event the agent `watcher` subscribes to.

### 2.3 `agent-policy` (crate `agent-policy`) — the on-chain LOCK

**Primary:** an OZ Smart Account **custom policy** implementing the OZ `Policy` trait. The treasury IS this smart-account wallet. The policy's `enforce()` cross-reads `GovVault` and **rejects any tx** unless the swap is approved, in-cap, correctly targeted/assetted, and single-shot.

**Verified OZ trait** (`OpenZeppelin/stellar-contracts` `packages/accounts/src/policies/mod.rs`, raw GitHub 2026-06-02). **CRATE NAME (binding, verified):** the published crate is **`stellar-accounts`** (NOT `openzeppelin-stellar-contracts` — that name does not exist on crates.io). Its lib root declares `pub mod policies; pub mod smart_account; pub mod verifiers;` — there is **no `accounts::` segment**. Import as `stellar_accounts::policies::Policy` and `stellar_accounts::smart_account::{...}`. Upgradeable utils (if needed by the host) live in the sibling crate **`stellar-contract-utils`** (`stellar_contract_utils::upgradeable`). Both are version **0.7.1**.

```rust
// The OZ Policy trait — provided by the `stellar-accounts` crate (we IMPLEMENT it).
// SOURCE: stellar-accounts 0.7.1 packages/accounts/src/policies/mod.rs (verified 2026-06-02).
pub trait Policy {
    type AccountParams: FromVal<Env, Val>;
    fn enforce(
        e: &Env,
        context: soroban_sdk::auth::Context,           // Context::Contract(ContractContext{contract, fn_name, args, ..})
        authenticated_signers: Vec<Signer>,            // smart_account::Signer
        context_rule: ContextRule,                     // smart_account::ContextRule
        smart_account: Address,
    );
    fn install(e: &Env, install_params: Self::AccountParams, context_rule: ContextRule, smart_account: Address);
    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address);
}
```

**Verified OZ helper types** (`packages/accounts/src/smart_account/storage.rs`, raw GitHub 2026-06-02):
- `Signer::{Delegated(Address), External(Address, Bytes)}` (an ed25519 session key is an `External(verifier_addr, pubkey_bytes)` whose `verifier_addr` is a contract implementing `stellar_accounts::verifiers::Verifier`).
- `ContextRuleType::{Default, CallContract(Address), CreateContract(BytesN<32>)}`.
- `ContextRule { id: u32, context_type: ContextRuleType, name: String, signers: Vec<Signer>, signer_ids: Vec<u32>, policies: Vec<Address>, policy_ids: Vec<u32>, valid_until: Option<u32> }` (FULL field set — `policies` is `Vec<Address>`, NOT `Vec<Signer>`).
- `AuthPayload { signers: Map<Signer, Bytes>, context_rule_ids: Vec<u32> }` — the smart-account host's `CustomAccountInterface::Signature` type. `context_rule_ids` is index-aligned with `auth_contexts`; the signed digest is `sha256(signature_payload.to_bytes() || context_rule_ids.to_xdr())` (signers sign THIS digest, not the raw payload — anti-downgrade).
- `soroban_sdk::auth::ContractContext { contract: Address, fn_name: Symbol, args: Vec<Val> }`.
- `do_check_auth(e: &Env, signature_payload: &Hash<32>, signatures: &AuthPayload, auth_contexts: &Vec<Context>) -> Result<(), SmartAccountError>` — the host delegate. It authenticates each `AuthPayload.signers` entry against the digest, then for every (rule, context) pair calls `PolicyClient::new(e, &policy).enforce(...)`. **It validates each context independently and does NOT reject a multi-context batch** — so the "single context" (MultiCall) rule must be enforced by the host `__check_auth` override (which holds `auth_contexts: Vec<Context>`) BEFORE delegating to `do_check_auth`; a `Policy::enforce` sees only ONE context and cannot count the batch.
- `stellar_accounts::smart_account` re-exports (all importable from that path): `self, do_check_auth, AuthPayload, ContextRule, ContextRuleEntry, ContextRuleType, ExecutionEntryPoint, Signer, SmartAccount, SmartAccountError`.

**Our AgentPolicy implementation:**

```rust
// contracts/agent-policy/src/lib.rs
use soroban_sdk::{
    auth::{Context, ContractContext}, contract, contracterror, contractimpl, contracttype,
    panic_with_error, symbol_short, Address, Env, FromVal, Symbol, Val, Vec,
};
// SOURCE: stellar-accounts 0.7.1 — modules live at the crate ROOT (`stellar_accounts::policies`,
// `stellar_accounts::smart_account`); there is NO `accounts::` segment (verified 2026-06-02).
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

#[contracttype]
#[derive(Clone)]
pub struct AgentPolicyParams {
    pub gov_vault: Address,      // GovVault contract id (cross-contract read)
    pub approved_amm: Address,   // the only legal swap target (SwapVenue impl)
    pub treasury_asset: Address, // the only asset that may leave the wallet
    pub proposal_id: u32,        // the single proposal this policy authorizes (single-shot binding)
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PolicyError {
    NotInstalled    = 1,
    NotApproved     = 2,  // (a) GovVault.is_approved(id) == false
    AlreadyExecuted = 3,  // (b) proposal already executed (single-shot)
    WrongTarget     = 4,  // (c) context contract != approved_amm
    WrongAsset      = 5,  // (d) asset_in arg != treasury_asset OR asset_in != approved action.asset_in
    OverCap         = 6,  // (e) amount_in > GovVault.cap_of(id)
    WrongFn         = 7,  // not the expected `swap` fn
    MultiCall       = 8,  // more than the single permitted contract context in the auth batch
    MalformedArgs   = 9,  // swap call has wrong arity / un-decodable args (NOT a business-rule violation)
    WrongAssetOut   = 10, // (f) asset_out arg != approved action.asset_out (funds routed to unapproved token)
}

#[contract]
pub struct AgentPolicy;

#[contractimpl]
impl Policy for AgentPolicy {
    type AccountParams = AgentPolicyParams;

    /// THE LOCK. Authorizes ONLY: Context::Contract whose
    ///   contract == approved_amm, fn_name == "swap",
    ///   args (arity exactly 4) = (asset_in: Address, amount_in: i128, min_out: i128, to: Address)
    /// AND ALL of:
    ///   (a) GovVault.is_approved(proposal_id);
    ///   (b) proposal status != Executed;
    ///   (c) cc.contract == approved_amm;
    ///   (d) asset_in == treasury_asset AND asset_in == GovVault.action_of(id).asset_in;
    ///   (e) amount_in <= GovVault.cap_of(proposal_id);
    ///   (f) asset_out (args.get(0) of the OTHER side — see arg-binding note) == GovVault.action_of(id).asset_out.
    /// Gate (f) BINDS the swap to the approved ActionSpec output asset so a hallucinating agent
    /// cannot route the approved cap of the treasury asset into a worthless/unapproved token.
    /// `swap(asset_in, amount_in, min_out, to)` carries only `asset_in`; the venue is a fixed-pair
    /// pool, so `asset_out` is the pool's OTHER asset. The policy derives it by reading
    /// `GovVault.action_of(id).asset_out` and asserting it equals the treasury asset's counter-asset
    /// for `approved_amm` — i.e. the approved-action output asset must be the venue's other side.
    /// (When the venue can route to multiple outputs, `swap` MUST take an explicit `asset_out` arg;
    /// for the M2 FallbackAMM fixed pair, binding `action.asset_out` is sufficient and is asserted.)
    /// Wrong arity / un-decodable args -> PolicyError::MalformedArgs (NOT WrongAsset/OverCap).
    /// Any other deviation -> panic_with_error!(e, PolicyError::...).
    /// SOURCE pattern: OZ spending_limit::enforce matches Context::Contract(ContractContext{fn_name,args,..})
    /// and decodes via args.get(N) + i128::try_from_val (verified 2026-06-02).
    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    );

    fn install(e: &Env, install_params: AgentPolicyParams, context_rule: ContextRule, smart_account: Address);
    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address);
}

#[contractimpl]
impl AgentPolicy {
    /// Read installed params (used by tests/UI). Panics NotInstalled if absent.
    pub fn params(env: Env, smart_account: Address) -> AgentPolicyParams;
}
```

- **Storage key** (`agent-policy`): `#[contracttype] enum PolicyKey { Params(Address) /* per smart_account */ }` (persistent).
- **Cross-contract read:** uses the generated `GovVaultClient` (`gov_vault::GovVaultClient::new(e, &params.gov_vault)`) to call `is_approved`, `proposal`, `cap_of`, `action_of` during `enforce`. **Open risk (spec §13.4 — UNVERIFIED until empirically tested):** NO OZ reference policy makes a cross-contract call inside `enforce` (`spending_limit::enforce` reads only its OWN `e.storage().persistent()` after `smart_account.require_auth()`; verified 2026-06-02). The §13.4 question — whether a `Policy::enforce` invoked through `do_check_auth` during authorization may cross-contract-read GovVault — is resolved EMPIRICALLY by the M2 OZ-host integration test, NOT assumed. **If direct cross-read in `enforce` is NOT permitted during auth, the fallback is NOT a stale mirror:** the authoritative treasury host becomes the hand-rolled `__check_auth` variant (proven to allow cross-reads, since `__check_auth` runs cross-contract reads in the OZ reference itself), so gates (a)/(b) are STILL read LIVE in the same auth — a same-tx revocation/execution is rejected. A non-auth `sync_from_gov` mirror is permitted ONLY if a test proves freshness by calling `sync_from_gov` inside the SAME auth batch immediately before the swap AND asserting a post-sync revocation/execution is rejected; absent that proof the live-cross-read host (hand-rolled or whichever OZ shape passes) is primary. See M2 plan Phase 1 / Phase 2 for the binding decision procedure.
- **The smart-account contract** that hosts this policy uses the OZ `CustomAccountInterface` + `SmartAccount` + `ExecutionEntryPoint` pattern (verified `examples/multisig-smart-account/account/src/contract.rs`, 2026-06-02): `use stellar_accounts::smart_account::{self, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint, Signer, SmartAccount, SmartAccountError};`, `__constructor(e, signers: Vec<Signer>, policies: Map<Address, Val>)`, `impl CustomAccountInterface { type Error = SmartAccountError; type Signature = AuthPayload; fn __check_auth(e: Env, signature_payload: Hash<32>, signatures: AuthPayload, auth_contexts: Vec<Context>) -> Result<(), SmartAccountError> { smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts) } }`, `#[contractimpl(contracttrait)] impl SmartAccount for X {}`, `#[contractimpl(contracttrait)] impl ExecutionEntryPoint for X {}`. **MultiCall is enforced by overriding `__check_auth` to count `Context::Contract` entries in `auth_contexts` and reject `> 1` (mapped to `PolicyError::MultiCall`) BEFORE delegating to `do_check_auth`** — `do_check_auth` itself validates contexts independently and would otherwise accept a multi-context batch.

**Fallback (`feature = "handrolled"`, spec D7):** `contracts/agent-policy/src/fallback.rs` ships a self-contained custom account that does NOT depend on OZ:

```rust
// feature = "handrolled" — hand-rolled __check_auth variant (spec D7 fallback)
use soroban_sdk::{auth::{Context, CustomAccountInterface}, contract, contractimpl, contracttype,
    crypto::Hash, Address, BytesN, Env, Vec};

#[contract]
pub struct HandRolledAgentAccount;

#[contractimpl]
impl HandRolledAgentAccount {
    pub fn init(env: Env, session_pubkey: BytesN<32>, gov_vault: Address,
                approved_amm: Address, treasury_asset: Address, proposal_id: u32);
}

#[contractimpl]
impl CustomAccountInterface for HandRolledAgentAccount {
    type Signature = BytesN<64>;          // ed25519 session-key signature
    type Error = soroban_sdk::Error;      // mapped to PolicyError codes
    /// Verifies session-key sig over signature_payload, then applies the SAME 5 gates
    /// (approved · not-executed · target==amm · asset==treasury · amount<=cap) over auth_contexts.
    fn __check_auth(env: Env, signature_payload: Hash<32>, signature: BytesN<64>,
                    auth_contexts: Vec<Context>) -> Result<(), Self::Error>;
}
```

Both variants enforce the **identical 5 gates** and have their own passing test suites (§7).

### 2.4 `swap-venue` (crate `swap-venue`) — venue-agnostic interface

```rust
// contracts/swap-venue/src/lib.rs
use soroban_sdk::{contractclient, Address, Env};

/// Common interface every venue (FallbackAMM, Soroswap adapter) satisfies.
/// AgentPolicy only ever authorizes calls to `swap` on the configured venue address.
#[contractclient(name = "SwapVenueClient")]
pub trait SwapVenue {
    /// Swap exactly `amount_in` of `asset_in` for >= `min_out` of the other asset, sent `to`.
    /// Returns the actual amount out. Reverts if out < min_out (slippage guard).
    fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128;

    /// Current reserves (reserve_a, reserve_b) keyed by the pool's canonical asset ordering.
    fn reserves(env: Env) -> (i128, i128);
}
```

`soroswap_adapter.rs` (M6) wraps the Soroswap router behind this trait; selection is a config switch (env `SWAP_VENUE=fallback|soroswap`), never a code fork in AgentPolicy.

### 2.5 `fallback-amm` (crate `fallback-amm`) — guaranteed demo liquidity

```rust
// contracts/fallback-amm/src/lib.rs
use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype,
    Address, Env};

#[contract]
pub struct FallbackAMM;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AmmError {
    NotInitialized   = 1,
    AlreadyInitialized = 2,
    UnknownAsset     = 3,   // asset_in is neither asset_a nor asset_b
    SlippageExceeded = 4,   // out < min_out
    InsufficientLiquidity = 5,
    ZeroAmount       = 6,
}

#[contractimpl]
impl FallbackAMM {
    /// Set the two pool assets (e.g. USDC SAC, XLM SAC). Once only.
    pub fn init(env: Env, asset_a: Address, asset_b: Address);

    /// Deposit liquidity; `from` must auth. Updates reserves.
    pub fn add_liquidity(env: Env, from: Address, amount_a: i128, amount_b: i128);

    /// Constant-product swap (x*y=k), 0.3% fee. Pulls `amount_in` from caller, pushes out to `to`.
    /// Reverts SlippageExceeded if computed out < min_out. Implements SwapVenue::swap.
    pub fn swap(env: Env, asset_in: Address, amount_in: i128, min_out: i128, to: Address) -> i128;

    /// (reserve_a, reserve_b). Implements SwapVenue::reserves.
    pub fn reserves(env: Env) -> (i128, i128);
}
```

Storage: `#[contracttype] enum AmmKey { AssetA, AssetB, ReserveA, ReserveB }` (instance). Event: `#[contractevent] struct Swapped { #[topic] pub asset_in: Address, pub amount_in: i128, pub amount_out: i128 }`.

### 2.6 `shadowkit-shared` (crate `shadowkit-shared`)

```rust
// contracts/shared/src/lib.rs   (no_std soroban lib)
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
    pub min_out: i128,       // slippage floor (min_out_policy materialized at create time)
}
// SPEC DEVIATION (intentional, recorded): the spec (§9, ActionSpec) names this field `min_out_policy`
// (a policy/expression evaluated later). The foundation MATERIALIZES it at proposal-create time into a
// concrete i128 floor and renames it `min_out`. This is a deliberate divergence — `min_out` here IS the
// spec's `min_out_policy` after materialization — not an accidental mismatch. Any cross-reference to the
// spec's `min_out_policy` maps to this `min_out`. Decision logged here so the divergence is traceable.

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
    pub weighted_yes: Option<i128>, // None until revealed
    pub weighted_no:  Option<i128>, // None until revealed
}

/// Opaque tlock ciphertext envelope stored on-chain (the sealed (direction,weight) vote).
/// `sealed_commitment_hash` MUST equal the proof's 4th public signal (binds proof↔ciphertext).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SealedVote {
    pub round: u64,                 // drand round the vote is timelocked to (== round(deadline))
    pub ciphertext: Bytes,          // tlock-js armored ciphertext bytes
    pub sealed_commitment_hash: BytesN<32>, // Poseidon/SHA over ciphertext; == public signal[3]
}

/// A single revealed (tlock-decrypted) vote, submitted to `close_and_reveal` for on-chain
/// re-aggregation. ONE per stored `SealedVote`, in the SAME order as `DataKey::SealedVotes(id)`.
/// `sealed_commitment_hash` MUST equal the corresponding `SealedVote.sealed_commitment_hash`
/// (the on-chain check that binds each decryption to its committed ciphertext). The chain sums
/// `weight` by `direction` and compares to `revealed_yes_w`/`revealed_no_w` (GovError::RevealMismatch
/// on any inconsistency). See `close_and_reveal` (§2.2) for the exact algorithm.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteDecryption {
    pub direction: u32,                     // 0 = no, 1 = yes (validated in {0,1})
    pub weight: i128,                       // token weight (must re-sum to the revealed aggregates)
    pub sealed_commitment_hash: BytesN<32>, // == the matching SealedVote.sealed_commitment_hash
}
```

---

## 3. TypeScript Module Interfaces (BINDING)

> TS conventions: ESM, `"type": "module"`, `strict: true`. Tests = Vitest. Public surface lives in each package's `src/index.ts`. Shared types from `@shadowkit/shared`.

### 3.1 `@shadowkit/shared` (`packages/shared/src/types.ts`)

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
  weightedYes: string | null; // null until revealed
  weightedNo: string | null;
}

export type AgentLogPhase = "reveal" | "data" | "plan" | "sign" | "submit" | "done" | "error";
export interface AgentLog {
  ts: number;                 // unix ms
  phase: AgentLogPhase;
  message: string;
  txHash?: string;
}

/** Mirrors the on-chain SealedVote (§2.6). `ciphertext` is base64 of tlock armored bytes. */
export interface SealedVoteCiphertext {
  round: number;                 // drand round == round(deadline)
  ciphertext: string;            // base64(tlock armored)
  sealedCommitmentHash: string;  // hex 0x.. 32 bytes; == publicSignals[3]
}

/** snarkjs Groth16 proof + the 4 BINDING public signals (order fixed, §4). */
export interface PublicSignals {
  merkleRoot: string;           // decimal field-element string (snarkjs format)
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

/** One revealed (tlock-decrypted) vote — mirrors on-chain `VoteDecryption` (§2.6).
 *  `sealedCommitmentHash` MUST equal the matching stored `SealedVote.sealed_commitment_hash`. */
export interface VoteDecryption {
  direction: 0 | 1;
  weight: string;               // i128 decimal
  sealedCommitmentHash: string; // hex 0x.. 32 bytes; == the stored ciphertext's commitment
}

/** Args for GovVault.close_and_reveal, produced by tally-reveal (§3.4).
 *  `decryptions` carries ONE VoteDecryption per stored sealed vote, in the SAME on-chain order;
 *  the chain re-aggregates them and rejects any aggregate inconsistent with the committed
 *  ciphertexts (GovError::RevealMismatch). Maps 1:1 to `close_and_reveal(id, revealedYesW,
 *  revealedNoW, decryptions: Vec<VoteDecryption>)`. */
export interface RevealArgs {
  proposalId: number;
  revealedYesW: string;  // i128 decimal
  revealedNoW: string;   // i128 decimal
  decryptions: VoteDecryption[];
}

/** snarkjs decimal field string -> 32-byte big-endian hex (for Bls12381Fr / contract args). */
export function fieldToBe32Hex(decimal: string): string;
/** Convert a SealedVoteCiphertext to the XDR/native shape for the GovVault binding. */
export function toScSealedVote(v: SealedVoteCiphertext): unknown;
```

### 3.2 `@shadowkit/zk-prover` (`packages/zk-prover/src/index.ts`)

> Verified (2026-06-02, installed type defs): snarkjs `0.7.6` (`groth16.fullProve`, `groth16.verify`), tlock-js `0.9.0` — **`timelockEncrypt(roundNumber: number, payload: Buffer, chainClient: ChainClient)`** (roundNumber is the FIRST arg), `timelockDecrypt(ciphertext: string, chainClient: ChainClient)`, re-exported `roundAt`/`roundTime` (NOT `roundForTime`/`timeForRound`), `mainnetClient`/`testnetClient`; drand-client (`fetchBeacon`, `HttpChainClient`, `HttpCachingChain`, `roundAt`, `roundTime`). SOURCE: installed `tlock-js/index.d.ts`, `drand-client/build/util.d.ts`. **NOTE: `poseidon-lite` is NOT a dependency** — TS Poseidon is computed via the BLS12-381 circuit wasm (`poseidonHashBls`, §6 FIELD NOTE / M4 §0.1); `poseidon-lite` (BN254) would silently produce the wrong field element.

```typescript
import type { Groth16Proof, PublicSignals, SealedVoteCiphertext } from "@shadowkit/shared";

export interface VoteInput {
  secret: string;        // voter's private field element (decimal string)
  merklePath: string[];  // sibling hashes root->leaf (decimal strings), length = TREE_DEPTH
  pathIndices: number[]; // 0/1 per level, length = TREE_DEPTH
  weight: string;        // token weight (decimal string); hidden
  proposalId: string;    // binds the proof; public signal
  direction: 0 | 1;      // 0 = no, 1 = yes; SEALED, never a public signal
  merkleRoot: string;    // expected public root (decimal string)
}

export interface VoteProofResult {
  proof: Groth16Proof;
  publicSignals: PublicSignals;       // [merkleRoot, nullifier, proposalId, sealedCommitmentHash]
  sealedCiphertext: SealedVoteCiphertext;
}

/** Build the Groth16 proof (snarkjs.groth16.fullProve over vote.wasm + vote_final.zkey),
 *  timelock-seal (direction,weight) to round(deadline) via tlock-js, and return both.
 *  The sealed ciphertext's commitment hash is fed in as publicSignals[3] so the proof
 *  attests the ciphertext is well-formed. */
export function generateVoteProof(
  input: VoteInput,
  artifacts: { wasmPath: string; zkeyPath: string },
  deadlineUnixSeconds: number,
  drand?: DrandConfig, // default: tlock-js mainnetClient (quicknet)
): Promise<VoteProofResult>;

/** Verify a proof off-chain against verification_key.json (snarkjs.groth16.verify).
 *  Used in tests and the off-chain-verify fallback path. Returns false for tampered proofs / wrong
 *  public signals (must have a NEGATIVE test, charter rule 1). */
export function verifyVoteProof(
  vkey: object,
  publicSignals: PublicSignals,
  proof: Groth16Proof,
): Promise<boolean>;

/** nullifier = Poseidon(secret, proposalId), as a decimal field string. ASYNC because Poseidon is
 *  computed via the BLS12-381 circuit wasm (foundation §6 FIELD NOTE / M4 §0.1 — NOT poseidon-lite,
 *  which is BN254). Consumers `await nullifierFor(...)`. */
export function nullifierFor(secret: string, proposalId: string): Promise<string>;

/** OFF-CHAIN VERIFY coordinator (fallback, §2.1). Runs the REAL snarkjs.groth16.verify and returns the
 *  `verified` flag that GovVault.cast_vote (feature = "offchain-verify") consumes. MUST refuse
 *  (verified === false) any proof that does not verify (charter rule 3). `packages/zk-prover/src/coordinator.ts`. */
export function verifyAndAuthorize(
  vkey: object, publicSignals: PublicSignals, proof: Groth16Proof,
): Promise<{ verified: boolean }>;

export interface DrandConfig { chainUrl: string; chainHash: string; }
```

`seal.ts`:
```typescript
import type { SealedVoteCiphertext } from "@shadowkit/shared";
/** Seal the (direction,weight) vote to the proposal deadline AND return the BLS12-381 Poseidon
 *  commitment `sealKey` that binds it (the circuit's private input for constraint #5).
 *  Call order is BINDING (M5 tlock path): timelockEncrypt(roundNumber, Buffer.from(JSON), chainClient)
 *  — roundNumber FIRST (tlock-js@0.9.0 index.d.ts). round = roundForDeadline(deadlineUnixSeconds).
 *  M4 ships a deterministic local-seal stub (round=0, base64-JSON ciphertext) that produces the REAL
 *  in-circuit Poseidon commitment; M5 replaces the ciphertext body with real tlock-js timelockEncrypt
 *  bound to round(deadline) (06-m5 plan). The `sealKey` is in the RESULT so `generateVoteProof` can
 *  feed the same value into the circuit's private `sealKey` input (the commitment must agree). */
export function timelockSealVote(
  direction: 0 | 1, weight: string, deadlineUnixSeconds: number, drand?: DrandConfig,
): Promise<SealedVoteCiphertext & { sealKey: string }>;
/** tlock-js timelockDecrypt (throws if round not yet reached). M4: local base64-JSON decode. */
export function timelockUnsealVote(
  sealed: SealedVoteCiphertext, drand?: DrandConfig,
): Promise<{ direction: 0 | 1; weight: string }>;
```

### 3.3 `@shadowkit/snapshot-tool` (`packages/snapshot-tool/src/index.ts`)

```typescript
export interface Holder { secretCommit: string; weight: string; } // secretCommit = Poseidon(secret)
export interface Snapshot {
  root: string;                                  // decimal field string (== on-chain MerkleRoot once be32)
  rootBe32Hex: string;                           // 0x.. 32-byte big-endian (for GovVault.init)
  getPath(leafIndex: number): { merklePath: string[]; pathIndices: number[] }; // SYNC (tree pre-materialized)
  leafCount: number;
  depth: number;                                 // == TREE_DEPTH (matches circuit)
}
/** Build a Poseidon Merkle tree where leaf = Poseidon(Poseidon(secret), weight) = Poseidon(secretCommit, weight).
 *  ASYNC (Promise<Snapshot>) because Poseidon is computed via the BLS12-381 circuit wasm (§6 FIELD NOTE /
 *  M4 §0.1 — poseidon-lite is BN254 and would silently produce the wrong field). Consumers (web
 *  VoteModal/ConnectBar, demo scripts, M5) `await buildSnapshot(...)`. `Snapshot.getPath` stays SYNC (the
 *  full tree is materialized at build time). This async deviation is RECORDED here per the "add the
 *  signature here first" rule and ripples to all snapshot consumers. */
export function buildSnapshot(holders: Holder[], depth?: number): Promise<Snapshot>;
```

### 3.4 `@shadowkit/tally-reveal` (`packages/tally-reveal/src/index.ts`)

```typescript
import type { SealedVoteCiphertext, RevealArgs } from "@shadowkit/shared";
import type { DrandConfig } from "@shadowkit/zk-prover";

import type { VoteDecryption } from "@shadowkit/shared";

/** At close: fetch beacon for `round`, tlock-decrypt every sealed vote (REAL tlock-js, charter rule 4),
 *  sum weighted yes/no. `decrypted[i]` corresponds to `sealedVotes[i]` (SAME order the chain stores). */
export function revealTally(
  sealedVotes: SealedVoteCiphertext[], drand?: DrandConfig,
): Promise<{
  yesW: string;
  noW: string;
  decrypted: Array<{ direction: 0 | 1; weight: string }>;
}>;

/** Build GovVault.close_and_reveal args: tlock-decrypt each sealed vote into a `VoteDecryption`
 *  (carrying its `sealedCommitmentHash` so the chain can bind it to the stored ciphertext) IN ORDER,
 *  and the recomputed `revealedYesW`/`revealedNoW`. The resulting `decryptions[]` is what the chain
 *  re-aggregates; `decryptions.length` MUST equal the stored sealed-vote count (§2.2). */
export function buildRevealArgs(
  proposalId: number, sealedVotes: SealedVoteCiphertext[], drand?: DrandConfig,
): Promise<RevealArgs>;
```

`drand.ts`: `export function roundForDeadline(deadlineUnixSeconds: number, drand?: DrandConfig): Promise<number>;`
Implemented with drand-client's **`roundAt(timeMs, chainInfo)`** (re-exported by tlock-js): fetch the chain's `ChainInfo` (via `HttpCachingChain(chainUrl, { chainHash }).info()`), then `roundAt(deadlineUnixSeconds * 1000, chainInfo)`. The inverse mapping (round → unix time) uses `roundTime(chainInfo, round)`. (There is no `roundForTime`/`timeForRound`; those names do not exist in tlock-js@0.9.0 — SOURCE: installed `drand-client/build/util.d.ts`.) **M5 binding requirement:** assert the round↔deadline mapping (`roundAt`/`roundTime` round-trip) against the REAL quicknet `ChainInfo`, and assert the sealed `SealedVote.round` equals `roundForDeadline(deadline)` (testing charter rule 2: primary tlock/drand path works on its own).

### 3.5 `@shadowkit/agent` (`agent/src/*`)

> **M3 AMENDMENT (2026-06-02, recorded per the "add the signature here first" rule, §0 preamble).**
> M3 (`04-m3-claude-planner.md`) needed three signatures not in the original binding; they are added below
> and are backward-compatible supersets of the originals (no existing call site breaks):
> 1. `AgentRunner` gains an **optional** second ctor arg `deps?: AgentDeps` (test-injection seam). Omitting it = the original `constructor(cfg)`.
> 2. `ClaudePlanner` ctor takes `ClaudePlannerConfig` = the original `{ apiKey; model }` **plus optional** `client?: AnthropicLike` and `logBus?: LogBus`.
> 3. New supporting interfaces `AgentDeps`, `GovReader`, `AnthropicLike`, `ClaudePlannerConfig` (all in `@shadowkit/agent`). `GovReader` is a thin TS wrapper over the existing GovVault `cap_of`/`action_of` entrypoints (§2.2) — no new contract method is invented.
> No other milestone plan references `AgentRunner(cfg, deps)` / `ClaudePlannerConfig` today, so there is no downstream ripple beyond M3.

```typescript
// index.ts
import type { AgentLog } from "@shadowkit/shared";
export interface AgentConfig {
  rpcUrl: string; networkPassphrase: string;
  govVaultId: string; agentPolicyId: string; swapVenueId: string;
  sessionSecretKey: string;          // ed25519 session key (S... strkey)
  premiumDataUrl: string;            // x402-protected endpoint the agent pays
  anthropicApiKey: string;
  useDeterministicPlanner: boolean;  // fallback switch (M2 default true; M3 false)
}
export class AgentRunner {
  /** `deps` is an OPTIONAL test-injection seam (M3 amendment). In production it is omitted and
   *  AgentRunner builds its collaborators from `cfg`. Added so M3 can test planner selection /
   *  auto-fallback / idempotency without a live network or chain (charter rule 4: the collaborators
   *  are injected, but the planner-SELECTION logic under test runs for real). */
  constructor(cfg: AgentConfig, deps?: AgentDeps);
  /** Full loop: watch -> reveal -> data -> plan -> sign -> submit -> done. Streams via onLog.
   *  RECORDED DIVERGENCE (M1/M2): the `reveal` phase + `tallyReveal.ts` require SEALED votes (tlock
   *  decrypt) which arrive in M5. M1/M2 use PLAINTEXT close, so `reveal` is a NO-OP and the M2
   *  `AgentRunner.run` implements `watch -> data -> plan -> sign -> submit -> done` (no `reveal`
   *  phase emitted, `tallyReveal.ts` not wired). The `reveal` phase + `tallyReveal` land in M5.
   *  This is intentional and documented in the M2 plan (Task M2-13) + its Verification log. */
  run(proposalId: number, onLog: (l: AgentLog) => void): Promise<{ txHash: string }>;
}

/** Test-injection seam for AgentRunner (M3 amendment — added to the foundation per the
 *  "add the signature here first" rule). These are the AgentRunner's COLLABORATORS, not the
 *  planner-selection logic itself. `govReader` is the thin TS read-adapter over the GovVault
 *  binding (see GovReader below); it reads cap/action from the on-chain `cap_of`/`action_of`
 *  entrypoints (§2.2). `makeClaudePlanner`/`makeDeterministicPlanner` are factories so the runner
 *  can build a planner with the live LogBus wired in. */
export interface AgentDeps {
  watcher: { waitForApproved(proposalId: number, pollMs?: number): Promise<void> };
  dataClient: { fetchMarket(pair: string): Promise<MarketData> };
  govReader: GovReader;
  executor: {
    executeSwap(plan: ActionPlan, spec: ActionSpec, cap: string, proposalId: number): Promise<{ txHash: string }>;
  };
  makeClaudePlanner(logBus: LogBus): Planner;
  makeDeterministicPlanner(): Planner;
}

/** TS read-adapter over the generated GovVault binding (from `@shadowkit/shared/bindings`, §1).
 *  M3 amendment. `capOf`/`actionOf` are the TS-side wrappers of the on-chain `cap_of`/`action_of`
 *  GovVault entrypoints (§2.2) — they invent NO new contract method; they call the existing binding
 *  and convert i128 -> decimal string (`capOf`) / the contract `ActionSpec` -> the TS `ActionSpec`
 *  (`actionOf`, §3.1). Lives in `agent/src/index.ts` (M2 already needs cap/action to build the swap;
 *  M3 stabilizes the shape as `GovReader`). */
export interface GovReader {
  capOf(proposalId: number): Promise<string>;     // i128 decimal string (foundation §5)
  actionOf(proposalId: number): Promise<ActionSpec>;
}

// watcher.ts
export class Watcher {
  constructor(cfg: { rpcUrl: string; govVaultId: string });
  /** Resolve when ProposalClosed(id, approved=true) event observed (or poll status==Approved). */
  waitForApproved(proposalId: number, pollMs?: number): Promise<void>;
}

// dataClient.ts  (verified: x402 client over @x402/stellar createEd25519Signer)
export interface MarketData { pair: string; price: string; signal: "buy" | "sell" | "hold"; }
export class DataClient {
  constructor(cfg: { url: string; signerSecret: string; network: string });
  /** GETs the x402-protected endpoint, auto-pays the 402 challenge, returns parsed data. */
  fetchMarket(pair: string): Promise<MarketData>;
}

// planner.ts
import type { ActionSpec } from "@shadowkit/shared";
export interface ActionPlan { amountIn: string; minOut: string; reasoning: string; }
export interface Planner {
  /** Decide amount/min_out (<= cap) given the approved ActionSpec + market data. */
  plan(spec: ActionSpec, cap: string, market: MarketData): Promise<ActionPlan>;
}
/** Claude-backed planner (Anthropic SDK). Hard cap is in the prompt AND re-validated by caller.
 *  M3 amendment: the constructor takes a `ClaudePlannerConfig` that EXTENDS the original
 *  `{ apiKey; model }` with two OPTIONAL fields — `client?` (an injectable `AnthropicLike` so tests
 *  replay a recorded real-model cassette at the network boundary only, charter rule 4) and
 *  `logBus?` (so each streamed reasoning delta is emitted as `AgentLog{phase:"plan"}`). Omitting both
 *  is identical to the original `{ apiKey; model }` binding (a real `Anthropic` client, no log sink),
 *  so this is a backward-compatible superset. */
export interface AnthropicLike {
  messages: {
    stream(args: unknown): {
      on(event: "text", cb: (delta: string) => void): unknown;
      finalMessage(): Promise<{ content: Array<{ type: string; text?: string }>; usage?: unknown }>;
    };
  };
}
export interface ClaudePlannerConfig {
  apiKey: string;
  model: string;
  client?: AnthropicLike; // injected fake in tests; default = new Anthropic({ apiKey })
  logBus?: LogBus;        // optional reasoning sink (streamed deltas -> AgentLog{phase:"plan"})
}
export class ClaudePlanner implements Planner { constructor(cfg: ClaudePlannerConfig); plan(...): Promise<ActionPlan>; }
/** Deterministic fallback (M2): amountIn=cap, minOut from market price - slippage. No LLM. */
export class DeterministicPlanner implements Planner { constructor(cfg?: { slippageBps?: number }); plan(...): Promise<ActionPlan>; }

// executor.ts
export class Executor {
  constructor(cfg: { rpcUrl: string; networkPassphrase: string; agentPolicyId: string; swapVenueId: string; sessionSecretKey: string });
  /** CLIENT-SIDE cap guard (defense-in-depth) -> build swap invocation -> sign w/ session key
   *  -> AgentPolicy.enforce validates on-chain -> submit. Idempotent on proposalId (mark_executed). */
  executeSwap(plan: ActionPlan, spec: ActionSpec, cap: string, proposalId: number): Promise<{ txHash: string }>;
}

// logBus.ts
import type { AgentLog } from "@shadowkit/shared";
export class LogBus {
  emit(log: AgentLog): void;
  subscribe(fn: (l: AgentLog) => void): () => void; // returns unsubscribe
}
```

### 3.6 `x402-services` (`x402-services/*/src/server.ts`)

> **VERIFIED 2026-06-02 (installed type defs `@x402/express@2.14.0` + `@x402/stellar@2.14.0` + `@x402/core@2.14.0`).** The Stellar x402 server uses the **scoped** package `@x402/express` (NOT the unscoped `x402-express`, which tops out at `1.2.0`, has a different signature, and branches only on EVM/SVM networks — it has ZERO Stellar support and would throw `Unsupported network` for `stellar:testnet`). `@x402/express@2.14.0` exports:
> ```
> paymentMiddleware(routes: RoutesConfig, server: x402ResourceServer,
>                   paywallConfig?: PaywallConfig, paywall?: PaywallProvider,
>                   syncFacilitatorOnStart?: boolean) => RequestHandler
> ```
> SOURCE: `@x402/express/dist/esm/index.d.mts` (line 147). There is **no** `payTo` first argument; the second argument is a pre-built `x402ResourceServer`, not a `FacilitatorConfig`.
>
> **Stellar wiring (the real construction):**
> - `x402ResourceServer` comes from `@x402/express` (re-exported — confirmed by the official `@x402/express` README which imports `{ paymentMiddleware, x402ResourceServer } from "@x402/express"`). Constructor: `new x402ResourceServer(facilitatorClients?: FacilitatorClient | FacilitatorClient[])`; chainable `.register(network: Network, server: SchemeNetworkServer)`. SOURCE: `@x402/core/dist/esm/x402Client-*.d.mts` (lines 300/320/328) + `coinbase/x402` `typescript/packages/http/express/README.md` (verified ctx7 `/coinbase/x402`, 2026-06-02).
> - The Stellar **server** scheme is `ExactStellarScheme` from the **`@x402/stellar/exact/server`** subpath (`implements SchemeNetworkServer`, default no-arg constructor). NOTE: the top-level `@x402/stellar` re-exports a *different* `ExactStellarScheme` from `./exact/client` — for the resource server you MUST import from `@x402/stellar/exact/server`. SOURCE: `@x402/stellar/dist/esm/exact/server/index.d.mts` (line 6/68) + `package.json` `exports`.
> - `createEd25519Signer(privateKey: string, defaultNetwork?: Network): Ed25519Signer` (SOURCE: `@x402/stellar` `signer-*.d.mts` line 138) builds the signer used by the **payer/client** side (`@shadowkit/agent` `DataClient`) and by the facilitator; the resource server itself only needs the `payTo` address + a `FacilitatorClient`. CAIP-2 networks `stellar:testnet` / `stellar:pubnet`; default USDC SAC + ledger-based expiry per `@x402/stellar`.
> - `RouteConfig` shape (SOURCE: `@x402/core` `x402Client-*.d.mts` line 698): `{ accepts: PaymentOption | PaymentOption[], description?, ... }` where `PaymentOption = { scheme: "exact", payTo: string, price: Price, network: Network, maxTimeoutSeconds? }`.
> - **`HTTPFacilitatorClient` is imported from `@x402/core/server`, NOT from `@x402/express`.** CORRECTED 2026-06-02 (ctx7 `/coinbase/x402`): the official `@x402/express` README imports `{ paymentMiddleware, x402ResourceServer } from "@x402/express"` and SEPARATELY `{ HTTPFacilitatorClient } from "@x402/core/server"`. The earlier claim that `@x402/express` re-exports `HTTPFacilitatorClient` is NOT confirmed by any doc and is contradicted by every official example; do not rely on it. `new HTTPFacilitatorClient({ url: facilitatorUrl })` (`FacilitatorConfig = { url?: string, createAuthHeaders? }`). express `5.2.1`. **Task 2.1 of the M6 plan MUST assert `/HTTPFacilitatorClient/.test(@x402/core/server d.mts)` (and STOP if absent) before importing it from `@x402/core/server`.**

#### 3.6a — REAL x402 settlement requires THREE distinct funded testnet accounts + USDC (BINDING)

> **VERIFIED 2026-06-02 (ctx7 `/coinbase/x402`: `typescript/packages/mechanisms/stellar/README.md`, `e2e/README.md`, `examples/typescript/servers/advanced/README.md`).** A real Stellar x402 settlement is a USDC (SEP-41 SAC) transfer, **not** an XLM payment, and it requires **three distinct accounts**, each its own funded testnet keypair:
>
> | Role | Env var (M6) | Funding requirement |
> |---|---|---|
> | **Client / payer** (the agent + tests) | `CLIENT_SECRET` (`S...`) | Friendbot XLM **+ USDC trustline + testnet USDC** (Circle faucet) — it spends USDC |
> | **Facilitator signer** (verifies + settles) | `FACILITATOR_SECRET` (`S...`), `FACILITATOR_ADDRESS` (`G...`) | Friendbot XLM (submits the settle tx; pays fees) |
> | **Resource server / payTo** (the owner being paid) | `RESOURCE_SERVER_ADDRESS` (`G...`) | Friendbot XLM **+ USDC trustline** (it receives USDC) |
>
> The official x402 e2e setup (`e2e/README.md`) states verbatim: "you need three separate Stellar accounts: one for the client, one for the server, and one for the facilitator. Each account requires generating a keypair and funding it with XLM via Friendbot. The client and server accounts additionally require a USDC trustline and testnet USDC from the Circle Faucet."
>
> **A SINGLE Friendbot-funded XLM account paying itself with no USDC trustline cannot settle an x402 payment** — the 402 challenge will appear but the 200-after-payment will never succeed. Therefore:
> - The M6 round-trip / premium-data / shadowkit-api / DataClient tests provision THREE keypairs and bootstrap USDC (`CLIENT_SECRET`, `FACILITATOR_SECRET`, `RESOURCE_SERVER_ADDRESS`); they SKIP (justified, charter rule 4) only when these are unset.
> - `scripts/deploy-testnet.sh` (M6) bootstraps the trustlines + USDC balance via `scripts/x402-bootstrap.ts`.
> - **Default USDC asset (testnet):** SEP-41 SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, 7 decimals (SOURCE: `coinbase/x402` `typescript/packages/mechanisms/stellar/README.md` + `specs/schemes/exact/scheme_exact_stellar.md`). USDC classic asset for the trustline: `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (Circle testnet issuer). Testnet USDC is minted from the Circle faucet `https://faucet.circle.com/` (select Stellar Testnet).

#### 3.6b — Exposing the local test facilitator over HTTP (BINDING)

> **VERIFIED 2026-06-02 (ctx7 `/coinbase/x402`: `e2e/facilitators/typescript/README.md`, `typescript/packages/core/README.md`).** Construct the facilitator and expose it over HTTP with the purpose-built router, NOT a hand-rolled `/verify` `/settle`:
> ```typescript
> import express from "express";
> import { x402Facilitator } from "@x402/core/facilitator";
> import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";   // FACILITATOR scheme
> import { createFacilitatorRouter } from "@x402/server/facilitator";     // the HTTP router helper
> const facilitator = new x402Facilitator().register("stellar:testnet", new ExactStellarScheme([signer]));
> const app = express();
> app.use(express.json());
> app.use("/", createFacilitatorRouter(facilitator));                     // mounts /verify, /settle, /supported
> ```
> - `facilitator.verify(paymentPayload, paymentRequirements)` and `facilitator.settle(paymentPayload, paymentRequirements)` take **TWO** arguments. `verify` returns `{ isValid: boolean, ... }` (note: `isValid`, NOT `valid`); `settle` returns `{ transaction, ... }`. SOURCE: `typescript/packages/core/README.md`.
> - `HTTPFacilitatorClient` POSTs `{ paymentPayload, paymentRequirements }` to the router's routes; `createFacilitatorRouter` is the matching server. Do NOT hand-roll `app.post('/verify', r => facilitator.verify(req.body))` — that passes one malformed arg and uses the wrong response key.
> - The facilitator-router package is **`@x402/server`** (pin `2.14.0`); add it to any package that stands up a facilitator.

```typescript
// x402-services/premium-data/src/server.ts  (agent PAYS this)
// VERIFIED API: @x402/express@2.14.0 paymentMiddleware(routes, server, ...) ; @x402/stellar@2.14.0
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server"; // NOT @x402/express (§3.6, verified)
import { ExactStellarScheme } from "@x402/stellar/exact/server"; // SERVER scheme (SchemeNetworkServer)

export function createPremiumDataServer(cfg: {
  payTo: string;            // Stellar address receiving payments (the resource owner)
  network: "stellar:testnet" | "stellar:pubnet"; // CAIP-2
  priceUsdc: string;        // e.g. "0.01" (parsed to USDC SAC by ExactStellarScheme)
  facilitatorUrl: string;   // x402 facilitator (e.g. OZ Channels facilitator / local test facilitator)
}): express.Express;
// Implementation MUST:
//   const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
//   const server = new x402ResourceServer(facilitator).register(cfg.network, new ExactStellarScheme());
//   const routes = { "GET /market/:pair": { accepts: { scheme: "exact", payTo: cfg.payTo,
//                                                       price: cfg.priceUsdc, network: cfg.network } } };
//   app.use(paymentMiddleware(routes, server));
// -> GET /market/:pair returns 402 until paid -> { pair, price, signal }

// x402-services/shadowkit-api/src/server.ts  (ShadowKit SELLS verify/execute)
export function createShadowKitApiServer(cfg: {
  payTo: string; network: "stellar:testnet" | "stellar:pubnet";
  govVaultId: string; rpcUrl: string; facilitatorUrl: string;
  priceUsdc?: string;
  direction?: "both" | "agent-pays-only";          // fallback: ungate the SELL side
  readApproved?: (id: number) => Promise<boolean>;  // injected GovVault.is_approved (default: real binding)
  runAgent?: (proposalId: number) => Promise<{ txHash: string }>; // injected agent kick (default: real AgentRunner)
}): express.Express;
// Same construction (x402ResourceServer + ExactStellarScheme server scheme + paymentMiddleware(routes, server)).
// POST /verify {proof,publicSignals} -> { valid } ; POST /execute {proposalId} behind the same middleware.
// /execute SEMANTICS (spec §6 step 6): gate on GovVault.is_approved(proposalId); only if approved, KICK the
// agent (AgentRunner.run) and return { accepted:true, proposalId, txHash }. Not-approved -> 403 (no kick).
// express.json() MUST be registered so the paid handlers can read req.body. readApproved/runAgent are
// injectable for unit/server tests; defaults wire the real GovVault binding + @shadowkit/agent AgentRunner.
```

> **M6 binding requirement:** before any task in `07-m6-...` references this section, re-run the end-to-end Stellar middleware construction above against the installed `@x402/express@2.14.0` + `@x402/stellar@2.14.0` (`new x402ResourceServer(...).register("stellar:testnet", new ExactStellarScheme())` then `paymentMiddleware(routes, server)`) and assert a real 402 → pay → 200 round-trip against a local facilitator (testing charter rule 4: REAL x402 flow, not a faked 200).

### 3.7 `web` frontend (`web/src/components/*` + `web/src/lib/*`)

> Verified: astro `6.4.2`, @astrojs/react `5.0.6`, smart-account-kit `0.2.10` (`SmartAccountKit`, `kit.connectWallet`, `kit.createWallet`, `kit.rules`, `kit.policies`, `createWebAuthnSigner`, `createDefaultContext`, `createCallContractContext`, `kit.signAndSubmit`).
>
> **CORRECTED 2026-06-02 (ctx7 `/kalepail/smart-account-kit`):** The `SmartAccountKit` constructor REQUIRES `{ rpcUrl, networkPassphrase, accountWasmHash, webauthnVerifierAddress }` (network config + the smart-account WASM hash + the WebAuthn verifier contract address). Optional: `storage` (e.g. `new IndexedDBStorage()`), `relayerUrl`, `indexerUrl` (string | false), `rpId`, `rpName`, `sessionExpiryMs`, `signatureExpirationLedgers`, `contextRuleProbe`. **There is NO `factoryContractId`/`factoryId` option** (the earlier signature was wrong). `kit.connectWallet(opts?)` does a SILENT session restore and **RETURNS `null` (does NOT throw)** when no stored session exists and no `prompt` is requested; `kit.connectWallet({ prompt: true })` shows the passkey selector. `kit.createWallet(appName, userName, { autoSubmit, autoFund, nativeTokenContract?, nickname? })` returns `{ contractId, credentialId, submitResult?, fundResult? }`. SOURCE: `context7.com/kalepail/smart-account-kit/llms.txt` (`SmartAccountKit — Constructor`, `kit.connectWallet()`, `kit.createWallet()`).

```typescript
// web/src/lib/wallet.ts
import { SmartAccountKit } from "smart-account-kit";
// accountWasmHash + webauthnVerifierAddress are REQUIRED by the 0.2.10 constructor (verified above).
export function createKit(cfg: {
  rpcUrl: string;
  networkPassphrase: string;
  accountWasmHash: string;          // smart-account contract WASM hash (deployed code)
  webauthnVerifierAddress: string;  // WebAuthn verifier contract id (C...)
  rpId?: string;                    // optional WebAuthn relying-party id
  rpName?: string;                  // optional WebAuthn relying-party name
}): SmartAccountKit;
// connect() PRIMARY: passkey — kit.connectWallet() (silent restore, may return null) then
// kit.createWallet(...) for a genuinely new user. FALLBACK: ed25519 keypair (WALLET_MODE=keypair).
export async function connect(
  kit: SmartAccountKit,
  opts?: { mode?: "passkey" | "keypair"; appName?: string; userName?: string; keypairSecret?: string },
): Promise<{ address: string; mode: "passkey" | "keypair" }>;

// React component prop contracts (all components are .tsx React islands):
export interface ConnectBarProps { kit: import("smart-account-kit").SmartAccountKit; onConnect: (addr: string) => void; }
export interface ProposalListProps { proposals: import("@shadowkit/shared").ProposalView[]; onSelect: (id: number) => void; }
export interface VoteModalProps {
  proposal: import("@shadowkit/shared").ProposalView;
  voterSecret: string; merklePath: string[]; pathIndices: number[]; weight: string; merkleRoot: string;
  onSubmitted: (nullifierHex: string) => void;
}
export interface SealedTallyPanelProps { proposal: import("@shadowkit/shared").ProposalView; nowUnix: number; }
// INVARIANT: SealedTallyPanel renders countdown + votesCast ONLY. It must NEVER read weightedYes/weightedNo.
export interface RevealedResultProps { proposal: import("@shadowkit/shared").ProposalView; } // requires status revealed
export interface AgentBoardTerminalProps { logs: import("@shadowkit/shared").AgentLog[]; }
export interface TreasuryPanelProps { balances: Array<{ asset: string; amount: string }>; }
```

---

## 4. Circuit Public/Private Signal Layout (Circom)

File: `circuits/vote/vote.circom`. Tooling: **Circom 2.2.1 + snarkjs (Groth16, BLS12-381)** (spec §5; reference verifier).

```circom
pragma circom 2.2.1;
include "poseidon.circom";   // circomlib Poseidon
include "merkle.circom";     // MerkleTreeChecker(TREE_DEPTH)

// TREE_DEPTH is BINDING and must equal snapshot-tool's depth (default 20).
template Vote(TREE_DEPTH) {
    // ---- PUBLIC SIGNALS (order is BINDING; matches GovVault pub_signals & §3 PublicSignals) ----
    signal input merkleRoot;             // [0] snapshot root
    signal input proposalId;             // [2] binds proof to a proposal (anti-replay)
    signal input sealedCommitmentHash;   // [3] hash committing to the sealed ciphertext (binds proof<->ciphertext)
    signal output nullifier;             // [1] = Poseidon(secret, proposalId)

    // ---- PRIVATE INPUTS ----
    signal input secret;                 // voter private scalar
    signal input weight;                 // token weight (hidden)
    signal input direction;              // vote choice {0,1} (hidden; sealed off-circuit)
    signal input pathElements[TREE_DEPTH];
    signal input pathIndices[TREE_DEPTH];
    signal input sealKey;                // randomness binding the ciphertext commitment

    // ---- CONSTRAINTS ----
    // 1) leaf = Poseidon(Poseidon(secret), weight)
    component secretCommit = Poseidon(1); secretCommit.inputs[0] <== secret;
    component leaf = Poseidon(2); leaf.inputs[0] <== secretCommit.out; leaf.inputs[1] <== weight;

    // 2) Merkle membership: MerkleVerify(leaf, path, root)
    component mt = MerkleTreeChecker(TREE_DEPTH);
    mt.leaf <== leaf.out; mt.root <== merkleRoot;
    for (var i = 0; i < TREE_DEPTH; i++) { mt.pathElements[i] <== pathElements[i]; mt.pathIndices[i] <== pathIndices[i]; }

    // 3) nullifier = Poseidon(secret, proposalId)
    component nf = Poseidon(2); nf.inputs[0] <== secret; nf.inputs[1] <== proposalId; nullifier <== nf.out;

    // 4) direction is a bit:  direction*(direction-1) === 0
    direction * (direction - 1) === 0;

    // 5) sealed-vote well-formedness: the public commitment hashes (direction, weight, sealKey),
    //    so the proof attests the sealed ciphertext encrypts THIS voter's true weight and a valid bit,
    //    WITHOUT revealing direction or weight.
    component sc = Poseidon(3);
    sc.inputs[0] <== direction; sc.inputs[1] <== weight; sc.inputs[2] <== sealKey;
    sealedCommitmentHash === sc.out;
}
component main {public [merkleRoot, proposalId, sealedCommitmentHash]} = Vote(20);
```

**Public signal vector (BINDING order):** `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]`.
- snarkjs lists `main`'s public outputs first then public inputs; the on-chain `pub_signals: Vec<Fr>` and `@shadowkit/shared` `PublicSignals` MUST be ordered exactly `[merkleRoot, nullifier, proposalId, sealedCommitmentHash]`. The wiring task (M4) verifies this ordering against `public.json` and asserts it in a test.
- **direction and weight are NEVER public.**

**Constraint summary:** (1) `secretCommit = Poseidon(secret)`; (2) `leaf = Poseidon(secretCommit, weight)`; (3) `MerkleTreeChecker(20)` proves `leaf ∈ root`; (4) `nullifier = Poseidon(secret, proposalId)`; (5) `direction ∈ {0,1}`; (6) `sealedCommitmentHash = Poseidon(direction, weight, sealKey)` binds the proof to the sealed ciphertext.

**Fallback ladder (M4/M5, spec §13.2):** on-chain verify → off-chain verify (drop constraint enforcement on-chain, keep proof). circuit hard → **membership + nullifier only** (drop signals (4)-(6), keep [merkleRoot, nullifier, proposalId]). reveal hard → coordinator commit-reveal → weight-unlinked → 1p1v. Each fallback has its own circuit/fixtures and tests.

---

## 5. Shared Data Types (cross-layer matrix)

| Concept | Rust (`shadowkit-shared`) | TS (`@shadowkit/shared`) | On-chain repr | Notes |
|---|---|---|---|---|
| Action | `ActionSpec { kind: SwapKind, asset_in, asset_out, amount: i128, min_out: i128 }` | `ActionSpec { kind:"swap", assetIn, assetOut, amount, minOut }` | `#[contracttype]` | `amount ≤ cap`; `min_out` is the **materialized** form of spec's `min_out_policy` (intentional rename, §2.6) |
| Proposal status | `ProposalStatus::{Open,Tallying,Approved,Rejected,Executed}` | `"Open"\|"Tallying"\|"Approved"\|"Rejected"\|"Executed"` | enum | |
| Proposal read | `ProposalView { id, action_spec, cap, deadline, votes_cast, status, weighted_yes: Option<i128>, weighted_no: Option<i128> }` | `ProposalView { ..., weightedYes: string\|null, weightedNo: string\|null }` | `#[contracttype]` | `weighted_*` None/null until reveal |
| Quorum | `QuorumCfg { min_voters: u32, yes_must_exceed_no: bool }` | — (set at deploy) | `#[contracttype]` | default `{3, true}` |
| Sealed vote | `SealedVote { round: u64, ciphertext: Bytes, sealed_commitment_hash: BytesN<32> }` | `SealedVoteCiphertext { round, ciphertext(base64), sealedCommitmentHash(hex) }` | `#[contracttype]` | `sealed_commitment_hash == publicSignals[3]` |
| Public signals | `Vec<groth16_verifier::Bls12381Fr>` (re-export of `soroban_sdk::crypto::bls12_381::Fr`, §2.1) order `[merkleRoot,nullifier,proposalId,sealedCommitmentHash]` | `PublicSignals { merkleRoot, nullifier, proposalId, sealedCommitmentHash }` | `Vec<Fr>` | order BINDING (§4); `Bls12381Fr` == `Fr` via §2.1 `pub use` |
| Reveal args | `close_and_reveal(id, revealed_yes_w: i128, revealed_no_w: i128, decryptions: Vec<VoteDecryption>)` | `RevealArgs { proposalId, revealedYesW, revealedNoW, decryptions: VoteDecryption[] }` | `VoteDecryption[]` (one per sealed vote) | on-chain re-aggregation → `RevealMismatch` (§2.2) |
| Vote decryption | `VoteDecryption { direction: u32, weight: i128, sealed_commitment_hash: BytesN<32> }` | `VoteDecryption { direction:0\|1, weight, sealedCommitmentHash }` | `#[contracttype]` | one per `SealedVote`, same order; binds via `sealed_commitment_hash` |
| Agent log | — | `AgentLog { ts, phase, message, txHash? }` | off-chain only | terminal stream |

**Quorum rule (demo default):** proposal passes iff `weighted_yes > weighted_no` AND `votes_cast >= min_voters` (default 3). Configurable via `QuorumCfg`.

**i128 across the boundary:** Rust uses `i128`; TS uses decimal `string` (never JS `number`) to avoid precision loss. snarkjs field elements use decimal strings; `fieldToBe32Hex` converts to 32-byte big-endian for `Bls12381Fr`/`BytesN<32>` contract args.

---

## 6. Toolchain & Versions (verified 2026-06-02)

| Layer | Tool / package | Version | Source / note |
|---|---|---|---|
| Rust | `rustc` / `cargo` | 1.94.1 | local toolchain (`rustc --version`). Pin in `rust-toolchain.toml`. |
| Rust target | `wasm32v1-none` | — | Soroban wasm target (Protocol 23+). `rustup target add wasm32v1-none`. |
| Soroban | `soroban-sdk` | **26.0.0** (BINDING, whole workspace) | The OZ `stellar-accounts` 0.7.1 workspace pins `soroban-sdk = { version = "26.0.0", features = ["experimental_spec_shaking_v2"] }` (verified raw GitHub `OpenZeppelin/stellar-contracts/Cargo.toml`, 2026-06-02). Because `agent-policy` depends on `stellar-accounts`, the ENTIRE Cargo workspace MUST standardize on `soroban-sdk 26.0.0` to avoid two SDK versions (Soroban host types are not cross-version compatible across the contract boundary). `groth16_verifier` upstream pins 25.1.0 but ShadowKit's fork uses 26.0.0; 26.0.0 retains the Protocol 23+/25 BLS12-381 + Poseidon host fns. **M1 crates (`shadowkit-shared`, `gov-vault`, `fallback-amm`, `swap-venue`) MUST be bumped to 26.0.0 in M2 Task 0 if M0/M1 set them to 25.1.0.** The `experimental_spec_shaking_v2` feature is an OZ-internal build optimization (smaller spec); it does NOT need to propagate to ShadowKit crates — our crates declare plain `soroban-sdk = "26.0.0"` and the feature is unified at link time by Cargo only for the OZ crate. (If a spec-shaking link error appears, add the feature to the workspace `soroban-sdk` dep.) |
| Soroban (OZ Smart Accounts) | `stellar-accounts` | **0.7.1** | The published crate is **`stellar-accounts`** (crate root: `pub mod policies; pub mod smart_account; pub mod verifiers;` — NO `accounts::` segment; import `stellar_accounts::policies::Policy`, `stellar_accounts::smart_account::{...}`). `OpenZeppelin/stellar-contracts` workspace `version = "0.7.1"`. There is **NO feature named `accounts`** — the crate IS the accounts package (depend on it plainly: `stellar-accounts = "0.7.1"`). Sibling crate `stellar-contract-utils = "0.7.1"` provides `upgradeable` if the host needs it. Dev-dep `ed25519-dalek = "2.1.1"` is used to produce real test signatures. |
| Soroban CLI | `stellar` (stellar-cli) | latest stable | NOT installed locally — M0 installs via `cargo install --locked stellar-cli` (or rustup component). Verify with `stellar --version` in M0. Used for build/deploy/bindings/quickstart. |
| ZK | `circom` | **2.2.1** | spec §5 (reference verifier). NOT installed locally — M0 builds from source `iden3/circom` tag `v2.2.1`. |
| ZK | `snarkjs` | **0.7.6** | `npm view snarkjs version`. Groth16 over BLS12-381. |
| ZK | `circomlib` | **2.0.5** | `npm view circomlib version`. Poseidon + Merkle templates. |
| ZK (TS) | ~~`poseidon-lite`~~ → **BLS12-381 circuit wasm** (`poseidonHashBls`) | — | **DECIDED (M4 §0.1 / §1 — BINDING, supersedes the original poseidon-lite plan): do NOT use `poseidon-lite`.** **FIELD NOTE (why):** poseidon-lite uses the BN254 field by default; circomlib Poseidon must use the SAME field the proving system uses. With Groth16-over-BLS12-381 the scalar field is BLS12-381's Fr, and poseidon-lite (BN254) would silently produce the WRONG field element. ShadowKit therefore computes all TS-side Poseidon via the **compiled BLS12-381 circuit wasm** (`@shadowkit/zk-prover` `poseidonHashBls`, see §3.2/§3.3 — `snarkjs.wtns.calculate` over the circuit wasm), which is the single source of truth and guarantees circuit↔TS↔on-chain field parity. `poseidon-lite` is NOT a dependency of any package. Still test the snarkjs↔on-chain↔TS Poseidon round-trip explicitly (M4). |
| Timelock | `tlock-js` | **0.9.0** | `npm view tlock-js version`. **VERIFIED arg order (installed `tlock-js/index.d.ts`):** `timelockEncrypt(roundNumber: number, payload: Buffer, chainClient: ChainClient): Promise<string>` (roundNumber FIRST), `timelockDecrypt(ciphertext: string, chainClient: ChainClient): Promise<Buffer>`, `mainnetClient()`/`testnetClient()`/`nonRFCMainnetClient()` (return `HttpChainClient`). It also **re-exports** `roundAt`/`roundTime` (from `drand-client`) — there are **no** `roundForTime`/`timeForRound` exports. SOURCE: `drand/tlock-js` `index.d.ts` (installed). |
| Timelock | `drand-client` | latest | `fetchBeacon`, `fetchBeaconByTime`, `HttpChainClient`, `HttpCachingChain`, `chainHash` param, and the round/time helpers **`roundAt(time: number /* ms */, chain: ChainInfo): number`** and **`roundTime(chain: ChainInfo, round: number): number`** (SOURCE: installed `drand-client/build/util.d.ts`). Default network: drand **quicknet** (used by tlock-js mainnetClient). |
| Timelock relay | `kaankacar/Drand-Relay` | repo | spec §13.3 stretch: on-chain drand-beacon BLS verify path. Verify at M5; not on the primary critical path (tlock-js + drand-client suffice for off-chain reveal). |
| Smart account (TS) | `smart-account-kit` | **0.2.10** | `npm view smart-account-kit version`. **Top-level NAMED exports** (verified installed `dist/index.d.ts` barrel): `SmartAccountKit` (class), and from `./builders`: `createWebAuthnSigner`, `createEd25519Signer`, `createDelegatedSigner`, `createExternalSigner`, `createDefaultContext`, `createCallContractContext`, `createCreateContractContext`, `createSpendingLimitParams`, `createThresholdParams`, `createWeightedThresholdParams`, `LEDGERS_PER_HOUR`, `LEDGERS_PER_DAY`, `LEDGERS_PER_WEEK`. **`convertPolicyParams` is NOT a top-level export** — it is exposed only as an INSTANCE METHOD on a `SmartAccountKit` (`kit.convertPolicyParams(policyType, params)`, verified `dist/kit.js:920`). **Kit INSTANCE members** (call on a constructed `kit`, NOT importable): `kit.connectWallet(...)`, `kit.signAndSubmit(...)`, `kit.convertPolicyParams("threshold"\|"spending_limit"\|"weighted_threshold", params)`, and the manager properties `kit.rules` (ContextRuleManager), `kit.policies` (PolicyManager: `kit.policies.add(ruleId, policyId, scvalParams)`). Do NOT `import { convertPolicyParams }` — it will fail. SOURCE: installed `smart-account-kit@0.2.10` `dist/index.d.ts` + `dist/kit.js`. **Constructor (CORRECTED 2026-06-02 ctx7 `/kalepail/smart-account-kit`): REQUIRES `{ rpcUrl, networkPassphrase, accountWasmHash, webauthnVerifierAddress }`; NO `factoryContractId`/`factoryId` option exists. `kit.connectWallet()` RETURNS `null` (does NOT throw) on no stored session; use `kit.connectWallet({ prompt: true })` to force the passkey selector. `kit.createWallet(appName, userName, { autoSubmit, autoFund, ... })` returns `{ contractId, credentialId, submitResult?, fundResult? }`.** |
| Payments | `@x402/express` | **2.14.0** | `npm view @x402/express version`. Export `paymentMiddleware(routes: RoutesConfig, server: x402ResourceServer, ...)` + re-exports `x402ResourceServer` (§3.6). **`HTTPFacilitatorClient` is imported from `@x402/core/server`, NOT from `@x402/express`** (CORRECTED 2026-06-02 ctx7 `/coinbase/x402`; the official `@x402/express` README imports it from `@x402/core/server`). **NOT the same as the unscoped `x402-express`** — that is a distinct, EVM/SVM-only package whose newest version is `1.2.0` (`x402-express@2.14.0` DOES NOT EXIST) and which throws `Unsupported network` for Stellar. Use the scoped `@x402/express` for Stellar. |
| Payments | `@x402/stellar` | **2.14.0** | `npm view @x402/stellar version`. **Server** scheme `ExactStellarScheme` from subpath `@x402/stellar/exact/server` (register on `x402ResourceServer`); **facilitator** scheme `ExactStellarScheme` from `@x402/stellar/exact/facilitator` (constructed `new ExactStellarScheme([signer])`); **client** `ExactStellarClient` from top-level `@x402/stellar` (`new x402Client().register("stellar:*", new ExactStellarClient(signer))`); `createEd25519Signer(privateKey, defaultNetwork?)` (signer factory); CAIP-2 nets, ledger expiry. Default USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (testnet, 7 decimals, SEP-41). SOURCE: ctx7 `/coinbase/x402` stellar README + installed `dist/esm/exact/server/index.d.mts` + `signer-*.d.mts`. |
| Payments core | `@x402/core` | **2.14.0** | transitive dep of `@x402/express`/`@x402/stellar`; provides `x402ResourceServer` (`@x402/core/server`), `HTTPFacilitatorClient` (`@x402/core/server`), `x402Facilitator` (`@x402/core/facilitator`), `x402Client` (`@x402/core/client`), `FacilitatorClient`, `RoutesConfig`, scheme types (`@x402/core/types`). |
| Payments (facilitator HTTP) | `@x402/server` | **2.14.0** | `npm view @x402/server version`. Provides `createFacilitatorRouter(facilitator)` from `@x402/server/facilitator` — the Express router that exposes a built `x402Facilitator` over HTTP (`app.use("/", createFacilitatorRouter(facilitator))`). SOURCE: ctx7 `/coinbase/x402` `e2e/facilitators/typescript/README.md`. |
| Payments (client fetch) | `@x402/fetch` | **2.14.0** | `npm view @x402/fetch version`. Provides `wrapFetchWithPayment(fetch, client)` (and re-exports `x402Client`). The payer side wraps native `fetch` to auto-pay 402. SOURCE: ctx7 `/coinbase/x402` `examples/typescript/clients/fetch/README.md`. |
| LLM | `@anthropic-ai/sdk` | **0.100.1** | `npm view @anthropic-ai/sdk version`. Planner model: a fast capable Claude model + prompt caching (spec §13.6). |
| Stellar SDK | `@stellar/stellar-sdk` | **15.1.0** | `npm view @stellar/stellar-sdk version`. Tx build/sign/submit, contract invocation, RPC. |
| Frontend | `astro` | **6.4.2** | `npm view astro version`. |
| Frontend | `@astrojs/react` | **5.0.6** | `npm view @astrojs/react version`. Vite build target `es2020` (tlock-js requirement). |
| Wallet (opt) | `@stellar/stellar-wallets-kit` | n/a on npm under that exact id | smart-account-kit covers passkey/connect; multi-wallet kit is optional. Verify id at M6 if needed. |
| Server | `express` | **5.2.1** | `npm view express version`. |
| Test (TS) | `vitest` | **4.1.8** | `npm view vitest version`. Multi-project aggregation via a ROOT `vitest.config.ts` with `test.projects` (`defineWorkspace` and the auto-loaded `vitest.workspace.ts` file were REMOVED in Vitest 4 — the `workspace` option was renamed to `test.projects` in 3.2 and the standalone workspace file dropped in 4). Verified ctx7 `/vitest-dev/vitest` v4.1.6 (migration guide: "`workspace` is replaced with `projects`"), 2026-06-02. |
| Merkle (TS) | `merkletreejs` 0.6.0 / `@zk-kit/incremental-merkle-tree` 1.1.0 | — | candidates for `snapshot-tool/merkle.ts`; choose the one whose Poseidon hashing matches the circuit. **Default: hand-build the tree using `poseidonHashBls` (the BLS12-381 circuit-wasm Poseidon, M4 §0.1) — NOT `poseidon-lite`** — to guarantee field parity with the circuit. |
| Task runner | `just` | latest | NOT installed locally — M0 installs (`cargo install just`). Verify `just --version`. |
| Node | `node` | **26.0.0** | local (`node --version`). pnpm or npm workspaces (default npm). |
| Network (local) | `stellar` quickstart container | — | `scripts/net-up.sh`; Docker required. M0 sets it up. |

**Versions to PIN exactly in lockfiles** (binding for reproducibility): `soroban-sdk 26.0.0`, `stellar-accounts 0.7.1`, `stellar-contract-utils 0.7.1`, `circom 2.2.1`, `snarkjs 0.7.6`, `circomlib 2.0.5`, `tlock-js 0.9.0`, `smart-account-kit 0.2.10`, `@x402/express 2.14.0`, `@x402/stellar 2.14.0`, `@x402/core 2.14.0`, `@x402/server 2.14.0`, `@x402/fetch 2.14.0`, `@anthropic-ai/sdk 0.100.1`, `@stellar/stellar-sdk 15.1.0`, `astro 6.4.2`, `vitest 4.1.8`. (There is NO `x402-express@2.14.0`; do not pin the unscoped package.)

**API VERIFICATION RULE (binding for all plans):** before writing any task that calls an external API, re-verify the current signature via `npx ctx7@latest library "<name>" "<question>"` then `npx ctx7@latest docs "<id>" "<question>"`, or WebFetch/`raw.githubusercontent.com`. Cite the source in a code comment when the call is non-obvious. Do NOT invent function/package/type names. If ctx7 returns a quota error, suggest `npx ctx7@latest login` / `CONTEXT7_API_KEY` and do not silently fall back to memory.

---

## 7. Testing Charter

### 7.1 The user's hard rules (VERBATIM — these govern every task)

> 1. **TEST EVERYTHING:** unit + integration + negative/adversarial + end-to-end. Every public fn / contract entrypoint / module has tests.
> 2. **PRIMARY PATH MUST WORK WITHOUT FALLBACK:** the ambitious primary implementation (on-chain Groth16 verify, token-weighted SEALED tally via tlock/drand, OZ Smart Account policy, Soroswap integration) must be fully implemented and PASS its tests on its own. The plan does NOT ship the fallback as the main thing.
> 3. **FALLBACKS MUST ALSO BE IMPLEMENTED AND TESTED:** every fallback named in the spec (off-chain verify; coordinator commit-reveal; weight-unlinked; 1p1v; hand-rolled `__check_auth`; FallbackAMM) is real, working code behind a config switch/feature flag, WITH its own passing test suite. No untested escape hatches.
> 4. **NO CHEATING:** no skipped/ignored tests (`#[ignore]`, `.skip`, `xfail`, `it.todo`) without an explicit written justification; no assertions that always pass; no mocking-away the thing under test (crypto tests use REAL proofs / REAL tlock encryption / REAL signatures, not stubs that fake success); TDD red MUST be shown (test fails before implementation). Tests assert real observable behavior and real on-chain state.
> 5. **ACCURACY:** before writing any API-bearing code, VERIFY the real API via ctx7 (run: `npx ctx7@latest library "<name>" "<question>"` then `npx ctx7@latest docs "<id>" "<question>"`) or WebFetch official docs/GitHub. Do NOT invent function names, package names, or signatures. Cite the source in a comment when non-obvious.

### 7.2 Concrete conventions (expansion of the rules)

**Test commands per layer** (each must be wired into the `justfile`; `just test` runs all):

| Layer | Command | What it runs |
|---|---|---|
| Rust contracts | `cargo test --workspace` | all `src/test.rs` unit + cross-contract integration (Soroban `Env`) |
| Rust (fallback features) | `cargo test --workspace --features handrolled` AND `cargo test -p gov-vault --features offchain-verify` | fallback paths under their feature flags |
| Circuit | `cd circuits/vote && npm test` | witness generation + snarkjs prove/verify + on-chain round-trip fixture check |
| TS packages | `vitest run` (workspace root) | every `@shadowkit/*` package's `*.test.ts` |
| TS fallback paths | `vitest run` with env (e.g. `USE_DETERMINISTIC_PLANNER=1`, `REVEAL_MODE=coordinator`) | fallback module suites |
| E2E demo loop | `just e2e` | spins local net, deploys all, runs full loop, asserts treasury moved + tally revealed |
| Everything | `just test` | all of the above, fails if any fails |

**Per-layer test taxonomy (from spec §10 — every milestone plan maps tasks to these):**

- **`groth16-verifier`:** valid proof → true; tampered proof / wrong public inputs / malformed VK → false or `Groth16Error` (NO panic). Uses **committed real fixtures** from `circuits/vote/fixtures/` (real snarkjs proof — never a stub).
- **`gov-vault`:** init; create_proposal; happy sealed vote; **double-vote (same nullifier) → `NullifierUsed`**; **replay (nullifier bound to other proposalId) → `WrongProposalId`**; post-deadline vote → `DeadlinePassed`; invalid proof → `InvalidProof`; **`proposal()` exposes NO tally before close** (assert `weighted_yes/no == None`); correct `close_and_reveal` → weighted tally; wrong reveal → `RevealMismatch`; quorum pass and fail; `mark_executed` single-shot → second call `AlreadyExecuted`.
- **`agent-policy` (= the safeguard proof; REAL auth, not `mock_all_auths` for the gate under test):** approved+in-cap+correct-target+correct-asset+valid-sig → **allow**; then 7 reject cases — not-approved → `NotApproved`; over-cap → `OverCap`; wrong target → `WrongTarget`; wrong asset → `WrongAsset`; already-executed → `AlreadyExecuted`; bad signature → reject; multi-call auth batch → `MultiCall`. **Both** the OZ-policy variant and the `handrolled` variant get the full matrix.
- **`fallback-amm`:** add_liquidity; constant-product swap math; `min_out` slippage revert (`SlippageExceeded`); reserves update.
- **Cross-contract integration:** deploy all (verifier, gov-vault, agent-policy, fallback-amm) → cast sealed votes → close+reveal → policy allows → swap → assert SAC balances moved. **Negative:** attempt execute without quorum/approval → blocked on-chain.
- **Circuit:** witness satisfiable for valid input; unsatisfiable for bad bit / wrong weight↔leaf / wrong nullifier derivation; snarkjs verify true; **snarkjs ↔ on-chain verify round-trip** (the same proof verifies in `groth16-verifier` test).
- **Timelock (REAL tlock):** a vote encrypted to round T is **undecryptable before T** (assert `timelockDecrypt` throws), decryptable after the beacon, and the tally over decrypted votes equals expected. Uses REAL `tlock-js` against a real drand chain (quicknet) or a deterministic test chain — never a stub that fakes decryption.
- **TS unit (Vitest):** `zk-prover` (real proof verifies; deterministic signals; sealed ciphertext round-trips via real tlock; bad input → error); `snapshot-tool` (root determinism; valid path accepted; tampered path → invalid); `tally-reveal` (correct aggregate; pre-deadline reveal attempt fails); `agent-middleware` (planner rejects over-cap plan with LLM **stubbed at the network boundary only** — the cap-guard logic is real; executor builds correct tx + client cap guard + idempotent; watcher triggers on close with RPC mock); `x402-services` (no payment → 402; valid payment → data; provider gating — using REAL x402 payment flow against a local facilitator, not a faked 200).
- **ClaudePlanner PRIMARY path (M3, charter rule 2 — primary works without fallback):** the network-stubbed cap-guard test above is NECESSARY BUT NOT SUFFICIENT. M3 MUST ALSO ship **at least one test that invokes the REAL Anthropic SDK** (`@anthropic-ai/sdk`) — either a recorded request/response cassette (e.g. a committed fixture replayed by a request interceptor) or a live call gated behind an env flag (e.g. `RUN_LIVE_LLM=1` + a present `ANTHROPIC_API_KEY`) — asserting that `ClaudePlanner.plan(spec, cap, market)` produces a valid, schema-conforming `ActionPlan` with `amountIn <= cap`. This is SEPARATE from the `DeterministicPlanner` fallback suite. Rationale: stubbing the LLM at the network boundary only exercises the cap-guard, never the primary planner's real model output, so the primary deliverable could otherwise pass CI without ever being exercised (the exact "primary not actually working" risk the charter forbids). If the live variant is env-gated/skipped, it requires the written justification per rule 4, and the cassette variant MUST still run by default in CI.
- **Frontend (Vitest + Testing Library):** `VoteModal` proves+seals+submits (zk-prover real or fixture); **`SealedTallyPanel` shows NO results pre-close** (assert it renders countdown + votesCast and does not render any number derived from weightedYes/weightedNo); `RevealedResult` renders post-close; terminal streams `AgentLog`.
- **E2E:** snapshot → proposal w/ deadline → N sealed votes (assert no tally visible) → reach deadline → reveal → agent executes → assert treasury changed AND tally revealed for the first time. Designed to **run repeatedly** ("demo never dies").

**Fixture strategy:**
- Circuit fixtures (`*.r1cs`, `*_final.zkey`, `verification_key.json`, sample `proof.json`/`public.json`/`input.json`) are **COMMITTED** under `circuits/vote/fixtures/`. The global ignore globs `*.r1cs`/`*.zkey`/`*.ptau` would otherwise hide them, so M0 (plan `01-m0-scaffold.md` Task 9) adds explicit force-keep negations to `.gitignore` (`!circuits/vote/fixtures/`, `!circuits/vote/fixtures/*.zkey`, `!circuits/vote/fixtures/*.r1cs`, `!circuits/vote/fixtures/*.ptau`) and verifies them with `git check-ignore`; large `.zkey`/`.ptau` outside that path stay ignored. Regenerate via `scripts/snapshot-fixtures.sh`. (Prior versions of this doc claimed the `.gitignore` "already" force-kept the path — it did NOT; the force-keep is now an explicit M0 deliverable.)
- `groth16-verifier/src/vk.rs` is generated FROM `verification_key.json` — a test asserts they stay in sync.
- Rust contract tests build their own `Env`, register contracts, and create SAC tokens via the `stellar` token utilities or test SAC; balances asserted as real on-chain state.
- tlock tests pin a known drand round so encryption/decryption are deterministic; the "undecryptable before T" assertion uses a future round.

**How TDD-red is demonstrated (mandatory in every implementation task):**
- Each feature task is split: (a) write failing test, (b) **run it and paste the exact command + the actual FAIL output** (e.g. `cargo test -p gov-vault test_double_vote_rejected` → `error[E0599]: no method named ... ` or assertion failure), (c) minimal implementation, (d) run again → PASS output, (e) commit. A task that shows green on first run without a prior red is invalid.

**How REAL crypto is tested (no faking):**
- Groth16: real snarkjs-generated proof from the committed circuit; tampering a byte must flip the result to false.
- tlock: real `timelockEncrypt`/`timelockDecrypt` from `tlock-js`; the decrypt-before-round test asserts a real thrown error.
- Signatures: real ed25519/secp256r1/WebAuthn signatures verified by the real host functions (`env.crypto().ed25519_verify`, `secp256r1_verify`); AgentPolicy auth tests do NOT `mock_all_auths()` for the signer/policy being tested.

**How primary AND fallback are both covered:** every milestone with a fallback ships TWO test suites — the primary (default build/config) and the fallback (feature flag / env switch) — both green. The plan's milestone is incomplete until both pass. No fallback may be present without a passing suite; no fallback may be the default.

**No-cheating audit (CI gate idea, enforced per task):** grep for `#[ignore]`, `.skip(`, `.only(`, `it.todo`, `xfail`, `assert!(true)`, `expect(true).toBe(true)` — any hit requires a written justification comment on the same line referencing the spec, else the task fails review.

---

## 8. Git / Commit Conventions

- **Conventional Commits.** Format: `type(scope): subject`. Types: `feat`, `fix`, `test`, `refactor`, `chore`, `docs`, `build`, `ci`. Scopes are the crate/package short name: `gov-vault`, `agent-policy`, `groth16`, `amm`, `circuit`, `zk-prover`, `snapshot`, `tally`, `agent`, `x402`, `web`, `shared`, `repo`.
  - Examples: `test(gov-vault): add failing double-vote rejection test`, `feat(gov-vault): reject reused nullifier`, `feat(agent-policy): enforce cap via GovVault cross-read`, `build(repo): scaffold cargo + npm workspaces`.
- **Commit cadence:** one commit per completed TDD cycle (red → green) or per atomic refactor. The minimal-implementation step that turns a red test green is its own commit. Never bundle multiple features in one commit. Commit frequently.
- **Branching:** never commit directly to the default branch. Create a feature branch per milestone (e.g. `m1-govvault-plaintext`). Commit/push only when the user asks.
- **Commit message footer** (required by environment rules) — end every commit body with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **PR bodies** end with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)` (use plain text per no-emoji preference where applicable; this footer is the documented exception).
- **DRY / YAGNI / TDD** apply to every task: no speculative abstraction, no code without a test, no duplicated logic across plans (shared logic lives in `shadowkit-shared` / `@shadowkit/shared`).

---

## 9. Milestone → Plan Map (for cross-reference)

> **Plan filenames are the DATED `2026-06-02-shadowkit-MN-*.md` form** (verified present on disk
> 2026-06-02). An earlier draft of this table used a hypothetical `NN-mN-*.md` scheme that was never
> adopted; the column below now lists the ACTUAL committed filenames so this single-source-of-truth map
> matches the repository.

| Milestone | Plan file (actual filename in `docs/superpowers/plans/`) | Builds | Primary | Fallback (must also pass) |
|---|---|---|---|---|
| **M0** | `2026-06-02-shadowkit-M0-foundation-scaffold.md` | workspaces, toolchain, local net, SAC tokens, `just test/deploy` green | full pipeline green | — |
| **M1** | `2026-06-02-shadowkit-M1-plaintext-governance-amm.md` | GovVault **plaintext** vote+quorum+approved; FallbackAMM+liquidity; FE list/vote/tally | plaintext loop | — |
| **M2** | `2026-06-02-shadowkit-M2-agent-policy-hero-loop.md` | AgentPolicy on OZ Smart Account (the lock); deterministic agent swap; agent terminal — **FULL HERO LOOP** | OZ custom policy | hand-rolled `__check_auth` (`feature=handrolled`) |
| **M3** | `2026-06-02-shadowkit-M3-llm-agent-planner.md` | Claude planner (split/slippage/timing ≤ cap), streamed reasoning | ClaudePlanner | DeterministicPlanner (M2) |
| **M4** | `2026-06-02-shadowkit-M4-zk-sealed-voting.md` | Circom circuit + snarkjs + adapted verifier → `cast_vote` requires proof; browser prover; snapshot-tool; sealed votes (direction hidden) | on-chain Groth16 verify | off-chain verify (`feature=offchain-verify`); circuit-hard → membership+nullifier only |
| **M5** | `2026-06-02-shadowkit-M5-timelock-weighted-reveal.md` | timelock-encrypt votes (tlock/drand) + weighted `close_and_reveal` at deadline | tlock/drand sealed-until-close | coordinator commit-reveal → weight-unlinked → 1p1v |
| **M6** | `2026-06-02-shadowkit-M6-x402-passkey-polish-deploy.md` | x402 both directions; passkey via smart-account-kit; Soroswap adapter via SwapVenue; README + threat model + testnet deploy | full product (passkey + Soroswap + x402 bidirectional) | x402 one-way; keypair instead of passkey; FallbackAMM instead of Soroswap |

Each plan's **File Structure** section must list exactly the files in §1 it touches, with the one-line responsibilities above, and must use only the signatures defined in §2-§5.

---

*End of foundation. All milestone plans (`01`-`07`) reference this document by section number. Any change to a binding signature here REQUIRES updating every dependent plan.*

---

## M0 Execution Learnings (stellar-cli 26.1.0 corrections)

These corrections were discovered during M0 execution (verified via `--help` and real runs on 2026-06-02). The committed scripts already reflect them; this section ensures M1–M6 implementers do not repeat the drift.

| # | Topic | Original plan (incorrect) | Verified reality (stellar-cli 26.1.0) |
|---|---|---|---|
| 1 | Local network start/stop | `stellar network container start/stop <net>` | `stellar container start <net>` / `stellar container stop <net>`. Also: quickstart:testing defaults to **protocol 25**; soroban-sdk 26.0.0 requires protocol 26 — pass `--protocol-version 26` to `stellar container start`. |
| 2 | `stellar network add` idempotency | Passed `--overwrite` flag | `stellar network add` has **no `--overwrite` flag** in 26.1.0. Re-adding an existing name exits 0 (idempotent by default). Remove `--overwrite` from any invocation. |
| 3 | Key generation | `stellar keys generate --global <name> --network <net> --fund` | `stellar keys generate` has **no `--global` flag** in 26.1.0. Keys are stored in `$XDG_CONFIG_HOME/stellar` by default. Drop `--global`. |
| 4 | SAC id resolution | `stellar contract id asset --source-account ... --network ... --asset <ASSET>` | `stellar contract id asset` has **no `--source-account` flag** in 26.1.0. Only `--network` and `--asset` are needed. |
| 5 | SAC deploy idempotency | `stellar contract asset deploy` assumed idempotent | Returns `Error(Storage, ExistingValue)` if the SAC already exists (e.g. second deploy cycle). Resolve via the idempotent helper: try `asset deploy`, fall back to `contract id asset` on non-zero exit. `deploy-local.sh`'s `deploy_or_resolve_sac()` implements this pattern. |
| 6 | vitest version | `vitest 4.1.8` (§6 table + pin list) | **`vitest 4.1.7`** is the highest version available on this machine's npm registry (date-gated to before 2026-05-31). `vitest 4.1.8` was never installable; `4.1.7` is pinned in `package-lock.json`. Separately, `vite` resolved to **7.3.3** (not 7.3.5 — no explicit pin; `ERESOLVE` prevented 7.3.5). Update §6 vitest row from `4.1.8` to `4.1.7` when this machine's npm registry is updated. |

**Note on §6 vitest row:** the table at §6 still reads `vitest 4.1.8`; the actual installed + locked version is `4.1.7`. This is a registry date-gate artifact, not a compatibility issue. M1+ implementers should verify `npm view vitest version` before bumping.
