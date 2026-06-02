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
test: test-contracts test-policy-handrolled test-ts circuit-test

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

# fallback feature paths (foundation §7.2). In M0 these crates are stubs with no such features yet,
# so the recipe builds them WITHOUT the flags; the flagged variants are added by M2 (handrolled)
# and M4 (offchain-verify). Kept here as named recipes so later milestones only fill the body.
test-contracts-fallbacks:
    @echo "fallback feature suites land in M2 (handrolled) / M4 (offchain-verify)"

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
