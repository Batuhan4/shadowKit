#!/usr/bin/env bash
# scripts/e2e-hero.sh — THE HERO LOOP, end-to-end on the LIVE local Stellar network (Task M2-16).
#
# "Demo never dies": runnable repeatedly. Each run creates a FRESH proposal (new id), votes it to
# Approved, funds the treasury, runs the REAL agent middleware (DeterministicPlanner -> Executor ->
# on-chain FallbackAMM.swap, REAL session-key signature), then ASSERTS real on-chain balance movement
# (treasury USDC down, WXLM up) and the proposal transitioning to Executed. Exits non-zero on any
# mismatch — NO `|| true` masking on the assertions (charter §7.2 no-cheating).
#
# Stages:
#   1) just net-up                         (idempotent: starts/keeps the quickstart container)
#   2) bash scripts/deploy-local.sh        (deploys gov-vault, USDC/WXLM SACs, FallbackAMM+liquidity,
#                                           agent-policy; sets voters + treasury + set_executor;
#                                           writes ids to .env.local)
#   3) create_proposal (USDC->WXLM, 10_000, cap 10_000, near deadline) on the live gov-vault
#   4) cast 3 weighted yes-votes -> quorum
#   5) wait for the deadline, close -> Approved
#   6) LIVE GATE READ PROOF: gov-vault.is_approved(id) == true (the exact value AgentPolicy.enforce
#      cross-reads during auth; the policy's own enforce path is proven in-Env — see the SIMULATED-STEP
#      note below)
#   7) fund the treasury with 10_000 USDC (trustline established in deploy)
#   8) run the REAL agent: node --experimental-strip-types agent/src/run-e2e.ts (real submit path)
#   9) ASSERT treasury USDC decreased by 10_000 AND WXLM increased; proposal status == Executed
#
# SIMULATED STEP (charter rule 4, honest disclosure): the on-network swap's authorizing identity is the
# agent's CLASSIC session/treasury account, NOT the OZ smart-account host whose custom __check_auth runs
# AgentPolicy.enforce. Reasons: (1) no deployable OZ host WASM exists (the host is #![cfg(test)]); and
# (2) stellar 26.1.0 `stellar contract invoke` cannot even invoke the agent-policy contract — it errors
# "Missing Entry Context" because the contract's exported spec references the OZ `Context` UDT (from
# Policy::enforce). The agent-policy WASM IS really deployed on-chain (proven in stage 2). The FULL
# host-gated enforce path (live GovVault cross-read + REAL ed25519 session signature; allow + the exact
# NotApproved block) is proven by the in-Env agent-policy integration tests (hero_loop_moves_balances /
# execute_without_quorum_is_blocked / cross_read_in_enforce_during_auth). Everything else here —
# deploys, proposal/vote/close, the balance-moving swap, mark_executed, the balance assertions — is REAL
# on the live network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

NET="${STELLAR_NETWORK:-local}"
DEPLOYER="${STELLAR_DEPLOYER:-shadowkit-deployer}"
RPC_URL="${LOCAL_RPC_URL:-http://localhost:8000/rpc}"
NET_PASSPHRASE="${LOCAL_NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"

# Strip the noisy (harmless) "local config found" migration banner from CLI output everywhere.
strip_noise() { grep -v "local config\|config migrate" || true; }

# Read a scalar return from a read-only invoke (last non-noise line; strips surrounding quotes).
invoke_read() {
  stellar contract invoke "$@" 2>/dev/null | strip_noise | tail -1 | tr -d '"'
}

ledger_now() {
  curl -s -X POST "${RPC_URL}" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
    | grep -o '"closeTime":"[0-9]*"' | grep -o '[0-9]*'
}

echo "==================== HERO LOOP (live local network) ===================="

# ---- 1) network up ----
echo "[hero] (1/9) net-up..."
just net-up >/dev/null 2>&1 || { echo "[hero] net-up failed"; exit 1; }

# ---- 2) deploy everything ----
echo "[hero] (2/9) deploy-local.sh (gov-vault, SACs, FallbackAMM+liquidity, agent-policy, treasury)..."
STELLAR_NETWORK="${NET}" bash scripts/deploy-local.sh > /tmp/hero-deploy.log 2>&1 || {
  echo "[hero] deploy failed; tail:"; tail -20 /tmp/hero-deploy.log; exit 1;
}

# load the deployed ids
test -f .env.local || { echo "[hero] .env.local not produced by deploy"; exit 1; }
set -a; . ./.env.local; set +a

echo "[hero] deployed ids:"
echo "       gov_vault    = ${GOV_VAULT_ID}"
echo "       usdc_sac     = ${USDC_SAC}"
echo "       wxlm_sac     = ${WXLM_SAC}"
echo "       fallback_amm = ${AMM_ID}"
echo "       agent_policy = ${AGENT_POLICY_ID}  (deployed on-chain; gated enforce path proven in-Env)"
echo "       treasury     = ${TREASURY_ADDR}"

# ---- 3) create a fresh proposal (USDC -> WXLM, 10_000, cap 10_000, near deadline) ----
NOW="$(ledger_now)"; DEADLINE=$((NOW + 12))
echo "[hero] (3/9) create_proposal (USDC->WXLM 10_000, cap 10_000, deadline ${DEADLINE})..."
PROPOSAL_ID="$(
  stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- create_proposal \
    --action_spec "{ \"amount\": \"10000\", \"asset_in\": \"${USDC_SAC}\", \"asset_out\": \"${WXLM_SAC}\", \"kind\": \"Swap\", \"min_out\": \"1\" }" \
    --cap 10000 --deadline "${DEADLINE}" 2>/dev/null | strip_noise | tail -1 | tr -d '"'
)"
echo "[hero] proposal id = ${PROPOSAL_ID}"
case "${PROPOSAL_ID}" in ''|*[!0-9]*) echo "[hero] FAIL: create_proposal did not return a numeric id"; exit 1;; esac

# ---- 4) cast 3 weighted yes-votes ----
echo "[hero] (4/9) cast 3 yes-votes..."
for n in 1 2 3; do
  vaddr="$(stellar keys address "shadowkit-voter${n}")"
  stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "shadowkit-voter${n}" --network "${NET}" \
    -- cast_vote --id "${PROPOSAL_ID}" --voter "${vaddr}" --direction 1 >/dev/null 2>&1 \
    || { echo "[hero] FAIL: voter${n} cast_vote failed"; exit 1; }
done
VOTES="$(invoke_read --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- votes_cast --id "${PROPOSAL_ID}")"
echo "[hero] votes_cast = ${VOTES}"
[ "${VOTES}" = "3" ] || { echo "[hero] FAIL: expected 3 votes, got ${VOTES}"; exit 1; }

# ---- 5) wait for deadline, close -> Approved ----
echo "[hero] (5/9) waiting for deadline ${DEADLINE} then closing..."
for _ in $(seq 1 40); do
  [ "$(ledger_now)" -gt "${DEADLINE}" ] && break
  sleep 2
done
stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- close --id "${PROPOSAL_ID}" >/dev/null 2>&1 || { echo "[hero] FAIL: close failed"; exit 1; }

# ---- 6) LIVE gate read proof: is_approved == true ----
APPROVED="$(invoke_read --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- is_approved --id "${PROPOSAL_ID}")"
echo "[hero] (6/9) gov-vault.is_approved(${PROPOSAL_ID}) = ${APPROVED}  (the exact value AgentPolicy.enforce cross-reads)"
[ "${APPROVED}" = "true" ] || { echo "[hero] FAIL: proposal not Approved after quorum + close"; exit 1; }

# ---- 7) fund the treasury with 10_000 USDC ----
echo "[hero] (7/9) minting 10_000 USDC to the treasury..."
stellar contract invoke --id "${USDC_SAC}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- mint --to "${TREASURY_ADDR}" --amount 10000 >/dev/null 2>&1 \
  || { echo "[hero] FAIL: USDC mint to treasury failed"; exit 1; }

USDC_BEFORE="$(invoke_read --id "${USDC_SAC}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
WXLM_BEFORE="$(invoke_read --id "${WXLM_SAC}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
echo "[hero] treasury BEFORE: USDC=${USDC_BEFORE}  WXLM=${WXLM_BEFORE}"
[ "${USDC_BEFORE}" -ge "10000" ] || { echo "[hero] FAIL: treasury USDC < 10000 before swap"; exit 1; }

# ---- 8) run the REAL agent middleware (live submit path) ----
echo "[hero] (8/9) running the REAL agent (DeterministicPlanner -> Executor -> on-chain swap)..."
TREASURY_SECRET="$(stellar keys show "${TREASURY_KEY}" 2>/dev/null | strip_noise | tail -1)"
[ -n "${TREASURY_SECRET}" ] || { echo "[hero] FAIL: could not read treasury secret"; exit 1; }

# Bundle the agent entry with esbuild (resolves the extensionless TS imports across agent/src; keeps
# node_modules packages external). node's native --experimental-strip-types does NOT do bundler-style
# extensionless resolution, so a one-shot esbuild bundle is the runnable form. Output to the repo root
# so @stellar/stellar-sdk + @shadowkit/shared resolve from ./node_modules. Cleaned up after the run.
BUNDLE="${ROOT}/.run-e2e-bundle.mjs"
trap 'rm -f "${BUNDLE}"' EXIT
node_modules/.bin/esbuild agent/src/run-e2e.ts --bundle --platform=node --format=esm \
  --packages=external --outfile="${BUNDLE}" >/dev/null 2>&1 \
  || { echo "[hero] FAIL: esbuild bundle of run-e2e.ts failed"; exit 1; }

PROPOSAL_ID="${PROPOSAL_ID}" \
GOV_VAULT_ID="${GOV_VAULT_ID}" \
AMM_ID="${AMM_ID}" \
TREASURY_ADDR="${TREASURY_ADDR}" \
TREASURY_SECRET="${TREASURY_SECRET}" \
LOCAL_RPC_URL="${RPC_URL}" \
LOCAL_NETWORK_PASSPHRASE="${NET_PASSPHRASE}" \
  node "${BUNDLE}" \
  || { echo "[hero] FAIL: agent run-e2e.ts failed"; exit 1; }

# ---- 9) ASSERT real on-chain balance movement + Executed ----
USDC_AFTER="$(invoke_read --id "${USDC_SAC}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
WXLM_AFTER="$(invoke_read --id "${WXLM_SAC}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
STATUS="$(
  stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- proposal --id "${PROPOSAL_ID}" 2>/dev/null | strip_noise | tail -1
)"
echo "[hero] (9/9) treasury AFTER:  USDC=${USDC_AFTER}  WXLM=${WXLM_AFTER}"

USDC_DELTA=$((USDC_AFTER - USDC_BEFORE))
WXLM_DELTA=$((WXLM_AFTER - WXLM_BEFORE))
echo "[hero] deltas: USDC=${USDC_DELTA}  WXLM=+${WXLM_DELTA}"
echo "[hero] proposal status (raw) contains: $(echo "${STATUS}" | grep -o 'Executed' || echo '<not Executed>')"

FAIL=0
[ "${USDC_DELTA}" -eq -10000 ] || { echo "[hero] ASSERT FAIL: expected USDC delta -10000, got ${USDC_DELTA}"; FAIL=1; }
[ "${WXLM_DELTA}" -gt 0 ]      || { echo "[hero] ASSERT FAIL: expected WXLM to INCREASE, got delta ${WXLM_DELTA}"; FAIL=1; }
echo "${STATUS}" | grep -q "Executed" || { echo "[hero] ASSERT FAIL: proposal not Executed"; FAIL=1; }
[ "${FAIL}" -eq 0 ] || { echo "[hero] ======== HERO LOOP FAILED ========"; exit 1; }

echo "========================================================================"
echo "HERO LOOP OK: USDC ${USDC_DELTA}, WXLM +${WXLM_DELTA}  (proposal ${PROPOSAL_ID} Executed)"
echo "========================================================================"
