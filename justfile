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
# M2 folds the agent-policy fallback (handrolled) suite + the agent middleware/terminal TS suite into
# the umbrella target. `test-ts` (npx vitest run) already runs agent/test + web/test, so test-agent is
# the explicitly-named M2 subset; we keep both for discoverability without double-running the whole
# suite (test depends on test-ts which is the superset; test-policy-handrolled adds the fallback cfg).
# M6 folds in the x402 service suites (test-x402) + the M6 fallback/config-selectable suites
# (test-fallbacks-m6: soroswap-feature swap-venue build + x402 onedir fallbacks). `test-ts` already
# covers the agent dataClient + swapVenueSelect suites (npx vitest run = all TS projects), but the
# soroswap-feature cargo build is NOT in `cargo test --workspace`, so test-fallbacks-m6 adds it.
test: test-contracts test-policy-handrolled test-ts circuit-test test-x402 test-fallbacks-m6

test-contracts:
    cargo test --workspace

# ---- M2: AgentPolicy primary (OZ policy) + fallback (hand-rolled) + agent middleware/terminal ----
test-policy:
    cargo test -p agent-policy

test-policy-handrolled:
    cargo test -p agent-policy --features handrolled

test-agent:
    npx vitest run agent/test web/test/AgentBoardTerminal.test.tsx

# ---- M3: live Gemini integration test (REAL gemini-2.5-flash call) ----
# Env-gated; reads GEMINI_API_KEY from .env (loaded above via `set dotenv-load`). Skipped cleanly
# without RUN_LIVE_LLM=1. Proves the PRIMARY (Gemini) planner returns a valid in-cap plan on its own.
test-llm-live:
    RUN_LIVE_LLM=1 npx vitest run agent/test/geminiPlanner.live.test.ts

# fallback feature paths (foundation §7.2). M0 stubbed this; M5 fills the body — it now runs the
# gov-vault feature-flag fallback suites (charter rule 3 "fallbacks must be tested too").
test-contracts-fallbacks: test-fallbacks

# ---- M5: full fallback matrix — EVERY feature-flag suite green in ONE command (charter rule 3) ----
# PRIMARY paths run under `just test` (default features); these are the FALLBACK builds:
#  - gov-vault offchain-verify   : trust coordinator-asserted proof validity (foundation §2.1)
#  - gov-vault circuit-min       : degraded membership+nullifier 1p1v circuit (spec §13.2)
#  - gov-vault coordinator-reveal: trust coordinator-asserted aggregate at close (D6, spec §12/§13.3)
#  - agent-policy handrolled     : hand-rolled AgentPolicy fallback (M2)
# The off-chain TS fallbacks (coordinator commit-reveal, weight-unlinked/1p1v, REVEAL_MODE selector)
# run inside `just test-ts` (npx vitest run covers packages/tally-reveal).
test-fallbacks:
    cargo test -p gov-vault --features offchain-verify
    cargo test -p gov-vault --features circuit-min
    cargo test -p gov-vault --features coordinator-reveal
    cargo test --workspace --features handrolled

test-ts:
    npx vitest run

web-test:
    npm run test --workspace web

# ---- M6: x402 services (both directions) ----
# Runs the unit + non-env-gated suites for the three x402 packages (shared-x402, premium-data,
# shadowkit-api). The LIVE 3-account testnet settlement tests inside these projects SKIP cleanly
# unless CLIENT_SECRET/FACILITATOR_SECRET/RESOURCE_SERVER_ADDRESS are set (charter rule 4 — a real
# USDC x402 settlement needs 3 funded testnet accounts + Circle-faucet USDC). To exercise the LIVE
# path: provision 3 funded accounts (Friendbot + USDC trustlines + Circle-faucet USDC for the
# CLIENT), export those env vars (e.g. via `set -a; . ./.env.x402; set +a`), then re-run `just test-x402`.
test-x402:
    npx vitest run --project @shadowkit/x402-shared --project @shadowkit/x402-premium-data --project @shadowkit/x402-api

# ---- M6 FALLBACK / config-selectable suites (charter rule 3: fallbacks must be tested too) ----
# The PRIMARY M6 paths run under `just test`'s `test-ts` (agent dataClient REAL x402 + swapVenueSelect)
# and `test-x402` (the x402 service suites). These are the M6 FALLBACK builds that aren't otherwise
# covered by the default chain:
#  - x402 onedir fallback   : X402_DIRECTION=agent-pays-only — the SELL side (shadowkit-api) runs UNGATED
#                             while premium-data (agent-pays) STAYS paywalled. Needs NO funded accounts
#                             (both onedir suites mint a random facilitator signer).
#  - swap-venue soroswap    : the Soroswap adapter feature build (calls the live router signature) — NOT
#                             in `cargo test --workspace`, so it is run explicitly here.
#  - agent SWAP_VENUE switch : the fallback|soroswap config selector (pure id selector, foundation §2.4).
# NOTE (deferred to the passkey/web batch — NOT this batch): the M6 plan also lists
# `WALLET_MODE=keypair npx vitest run web/test/passkey.test.ts` here. That web/passkey suite is Task 7
# (passkey/WebAuthn), owned by a separate batch; it is intentionally omitted until that file exists so
# `just test` stays green. Re-add the keypair-fallback line when Task 7 lands web/test/passkey.test.ts.
test-fallbacks-m6:
    X402_DIRECTION=agent-pays-only npx vitest run x402-services/shadowkit-api/test/onedir.test.ts x402-services/premium-data/test/onedir.test.ts
    cargo test -p swap-venue --features soroswap soroswap_adapter
    npx vitest run agent/test/swapVenueSelect.test.ts

# Run the agent-pays premium-data service on $PREMIUM_DATA_PORT (default 4100). Needs
# RESOURCE_SERVER_ADDRESS + X402_FACILITATOR_URL in the env (foundation §3.6a).
x402-premium-data-up:
    npm run start --workspace @shadowkit/x402-premium-data

# Run the ShadowKit-sells verify/execute API on $SHADOWKIT_API_PORT (default 4200). Needs the x402
# env (RESOURCE_SERVER_ADDRESS, X402_FACILITATOR_URL) + GOV_VAULT_ID + RPC_URL (foundation §3.6).
x402-api-up:
    npm run start --workspace @shadowkit/x402-api

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

# ---- HERO LOOP (M2-16): full vote -> approve -> agent-swap -> balances-move, on the LIVE local net.
# "Demo never dies" — runnable repeatedly. scripts/e2e-hero.sh net-ups, deploys, creates+votes+closes a
# proposal, runs the REAL agent middleware (DeterministicPlanner -> Executor -> on-chain FallbackAMM
# swap), then asserts the treasury's on-chain USDC/WXLM balances MOVED and the proposal is Executed.
# Exits non-zero on any mismatch. Required (not optional) when Docker is present.
e2e-hero:
    bash scripts/e2e-hero.sh

# ---- M6 SHOWCASE: the full SEALED-ZK demo loop (the M6 hero deliverable) ----
# private SEALED vote (REAL Groth16 proof + REAL tlock seal) -> deadline -> tlock REVEAL ->
# on-chain close_and_reveal (weighted tally) -> agent auto-executes the approved swap through the
# policy-gated treasury -> REAL on-chain balance movement (USDC down, WXLM up) + proposal Executed.
# scripts/demo.sh net-ups + deploys the FULL sealed system (groth16-verifier + sealed gov-vault +
# FallbackAMM + agent-policy + treasury), creates a proposal with a near deadline, casts 3 REAL sealed
# votes (direction HIDDEN on-chain), asserts NO tally leaks before close, tlock-decrypts at the
# deadline (REAL drand quicknet), closes on-chain, runs the REAL agent swap, and asserts the deltas.
# REVEAL MODE: real-tlock by default (REVEAL_MODE=timelock); REVEAL_MODE=coordinator is the documented
# fallback. "Demo never dies" — runnable repeatedly.
demo:
    bash scripts/demo.sh --network local

# Run the demo on TESTNET (the M6 primary deliverable). deploy-testnet.sh provisions the full sealed
# system on testnet; demo.sh --network testnet then runs the loop and asserts the real deltas.
demo-testnet:
    bash scripts/deploy-testnet.sh
    bash scripts/demo.sh --network testnet

# Deploy the full SEALED system (parameterized): `just deploy-demo` (local) writes .env.demo.local;
# the testnet form is `bash scripts/deploy-testnet.sh` (writes .env.demo.testnet).
deploy-demo:
    bash scripts/deploy-demo.sh --network local

# The demo-script TEST (the user's "demo script test" requirement). Runs the full LOCAL loop TWICE via
# vitest and asserts both runs print "DEMO OK (local)". Gated on RUN_DEMO_TEST=1 (drives the live
# local container + real proving + real tlock; documented gate, charter rule 4 — not a bare skip).
demo-test:
    just net-up
    RUN_DEMO_TEST=1 npx vitest run --config scripts/vitest.config.ts
