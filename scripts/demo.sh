#!/usr/bin/env bash
# scripts/demo.sh — THE SHADOWKIT SHOWCASE: the full SEALED-ZK e2e loop on a LIVE Stellar network.
#
#   private SEALED vote (REAL Groth16 proof + REAL tlock seal)  ->  deadline  ->  tlock REVEAL
#   ->  on-chain close_and_reveal (weighted tally)  ->  agent auto-executes the approved swap through
#   the policy-gated treasury  ->  REAL on-chain balance movement (USDC down, WXLM up) + Executed.
#
# "Demo never dies": runnable repeatedly. Each run creates a FRESH proposal (new id), casts 3 REAL
# sealed votes (direction HIDDEN on-chain — only opaque tlock ciphertext + a zk-verified nullifier),
# asserts NO tally is visible before close, waits for the deadline, tlock-DECRYPTS the votes (REAL
# drand quicknet beacon), closes on-chain (re-aggregated weighted tally -> Approved), then runs the
# REAL agent middleware to execute the swap and ASSERTS real on-chain balance deltas + Executed.
# Exits 0 ONLY if the treasury moved AND the tally was revealed. NO `|| true` on the assertions.
#
#   --network local|testnet   (default local)
#
# REVEAL MODE: the automated `just demo`/demo-test uses REAL tlock (REVEAL_MODE=timelock, default) —
# votes are sealed to a near-future drand round and genuinely undecryptable until it releases. Set
# REVEAL_MODE=coordinator to use the documented coordinator fallback (requires the gov-vault built
# with --features coordinator-reveal). The real-tlock path is the showcase and the default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

NETWORK=local
while [ $# -gt 0 ]; do case "$1" in --network) NETWORK="$2"; shift 2;; *) shift;; esac; done

REVEAL_MODE="${REVEAL_MODE:-timelock}"
# How far out the deadline is. Real tlock needs the drand round (quicknet period 3s) to RELEASE after
# the deadline before decrypt works, so keep it short but safely past a few rounds. ~40s default.
DEADLINE_OFFSET="${DEMO_DEADLINE_OFFSET:-40}"

strip_noise() { grep -vE "local config|config migrate" || true; }
invoke_read() { stellar contract invoke "$@" 2>/dev/null | strip_noise | tail -1 | tr -d '"'; }

# ---- 0) deploy (idempotent) + load ids ----
# SKIP_DEPLOY=1 reuses the EXISTING .env.demo.<network> deployment (no redeploy) — used to provision
# demo state (fresh proposals) against the already-deployed, site-wired contracts without changing ids.
# STOP_AFTER=approve|fund|execute (default execute) lets a provisioning run stop early (e.g. leave an
# Approved+funded proposal for the AgentBoard demo to execute live).
ENV_FILE=".env.demo.${NETWORK}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
STOP_AFTER="${STOP_AFTER:-execute}"
if [ "${SKIP_DEPLOY}" = "1" ]; then
  echo "==> [0/8] SKIP_DEPLOY=1 — reusing existing ${ENV_FILE} (no redeploy)"
  test -f "${ENV_FILE}" || { echo "[demo] SKIP_DEPLOY=1 but ${ENV_FILE} missing"; exit 1; }
  set -a; . "./${ENV_FILE}"; set +a
else
  echo "==> [0/8] deploy the full sealed system (network=${NETWORK})"
  if [ "${NETWORK}" = "local" ]; then
    just net-up >/dev/null 2>&1 || { echo "[demo] net-up failed"; exit 1; }
  fi
  bash scripts/deploy-demo.sh --network "${NETWORK}" > /tmp/shadowkit-demo-deploy.log 2>&1 || {
    echo "[demo] deploy failed; tail:"; tail -25 /tmp/shadowkit-demo-deploy.log; exit 1;
  }
  test -f "${ENV_FILE}" || { echo "[demo] ${ENV_FILE} not produced by deploy"; exit 1; }
  set -a; . "./${ENV_FILE}"; set +a
fi

DEPLOYER="${STELLAR_DEPLOYER:-shadowkit-deployer}"
NET="${NETWORK}"
echo "    verifier=${GROTH16_VERIFIER_ID}"
echo "    gov_vault=${GOV_VAULT_ID}"
echo "    fallback_amm=${FALLBACK_AMM_ID}"
echo "    agent_policy=${AGENT_POLICY_ID}"
echo "    usdc=${USDC_ID}  wxlm=${WXLM_SAC}  treasury=${TREASURY_ADDR}"

# ---- ledger-time helper ----
ledger_now() {
  curl -s -X POST "${RPC_URL}" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
    | grep -o '"closeTime":"[0-9]*"' | grep -o '[0-9]*'
}

# ---- 1) create a SEALED swap proposal (USDC -> WXLM, 10_000, cap 10_000, near deadline) ----
NOW="$(ledger_now)"
DEADLINE=$(( NOW + DEADLINE_OFFSET ))
echo "==> [1/8] create proposal (USDC->WXLM 10_000, cap 10_000, deadline ${DEADLINE} = now+${DEADLINE_OFFSET}s)"
PROPOSAL_ID="$(
  stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- create_proposal \
    --action_spec "{ \"amount\": \"10000\", \"asset_in\": \"${USDC_ID}\", \"asset_out\": \"${WXLM_SAC}\", \"kind\": \"Swap\", \"min_out\": \"1\" }" \
    --cap 10000 --deadline "${DEADLINE}" 2>/dev/null | strip_noise | tail -1 | tr -d '"'
)"
case "${PROPOSAL_ID}" in ''|*[!0-9]*) echo "[demo] FAIL: create_proposal did not return a numeric id (got '${PROPOSAL_ID}')"; exit 1;; esac
echo "    proposal id = ${PROPOSAL_ID}"

# ---- 2) generate + cast 3 REAL sealed votes (direction HIDDEN on-chain) ----
echo "==> [2/8] generating 3 REAL sealed votes (Groth16 proofs + tlock seal to round@deadline)..."
VOTES_BUNDLE="${ROOT}/.demo-bundle/gen-sealed-votes.mjs"
bash scripts/demo/_bundle.sh scripts/demo/gen-sealed-votes.ts "${VOTES_BUNDLE}"
VOTES_JSON="/tmp/shadowkit-demo-votes.json"
node "${VOTES_BUNDLE}" --proposal-id "${PROPOSAL_ID}" --deadline "${DEADLINE}" > "${VOTES_JSON}" 2>/tmp/shadowkit-demo-gen.log || {
  echo "[demo] FAIL: sealed-vote generation failed; tail:"; tail -15 /tmp/shadowkit-demo-gen.log; exit 1;
}
N_VOTES="$(node -e 'const v=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(String(JSON.parse(v).votes.length))' "${VOTES_JSON}")"
echo "    generated ${N_VOTES} sealed votes"

echo "==> [2b/8] casting ${N_VOTES} sealed votes on-chain (each verifies a Groth16 proof; tally stays HIDDEN)..."
for i in $(seq 0 $((N_VOTES - 1))); do
  PROOF="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(v.votes[+process.argv[2]].proof))' "${VOTES_JSON}" "${i}")"
  PUB="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(v.votes[+process.argv[2]].pubSignals))' "${VOTES_JSON}" "${i}")"
  CT="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const s=v.votes[+process.argv[2]].sealedCiphertext;process.stdout.write(JSON.stringify({ciphertext:s.ciphertext,round:s.round,sealed_commitment_hash:s.sealed_commitment_hash}))' "${VOTES_JSON}" "${i}")"
  stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- cast_vote --id "${PROPOSAL_ID}" --proof "${PROOF}" --pub_signals "${PUB}" --sealed_ciphertext "${CT}" \
    >/dev/null 2>/tmp/shadowkit-demo-cast.log || {
      echo "[demo] FAIL: cast_vote $((i+1))/${N_VOTES} failed; tail:"; tail -10 /tmp/shadowkit-demo-cast.log; exit 1;
    }
  echo "    cast sealed vote $((i+1))/${N_VOTES} (zk-verified, direction hidden)"
done

# ---- 3) assert NO tally visible before close (the privacy invariant) ----
echo "==> [3/8] asserting tally is SEALED (no weighted_yes/no before close)..."
VIEW="$(stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- proposal --id "${PROPOSAL_ID}" 2>/dev/null | strip_noise | tail -1)"
VOTES_CAST="$(invoke_read --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- votes_cast --id "${PROPOSAL_ID}")"
# weighted_yes/no MUST be null (Option None) before close. The view JSON shows "weighted_yes":null
# before close and "weighted_yes":"350" (a quoted i128) after close. A LEAK is any non-null value.
if echo "${VIEW}" | grep -qE '"weighted_yes":"?[0-9]'; then
  echo "[demo] FAIL: TALLY LEAKED before close: ${VIEW}"; exit 1;
fi
echo "    SEALED OK: votes_cast=${VOTES_CAST}, weighted tally hidden (weighted_yes/no = null)"

# ---- 4) wait for the deadline (ledger time) + the drand round release ----
echo "==> [4/8] waiting for deadline ${DEADLINE} (ledger time) + drand round release..."
for _ in $(seq 1 60); do
  CUR="$(ledger_now)"
  [ "${CUR}" -gt "${DEADLINE}" ] && break
  sleep 2
done
[ "$(ledger_now)" -gt "${DEADLINE}" ] || { echo "[demo] FAIL: deadline not reached after wait"; exit 1; }
# Real tlock needs the drand round (sealed to ~deadline) to have RELEASED; give it a small margin.
sleep 6

# ---- 5) tlock-REVEAL + close_and_reveal on-chain ----
echo "==> [5/8] tlock-revealing the sealed tally (REAL drand decrypt, mode=${REVEAL_MODE})..."
REVEAL_BUNDLE="${ROOT}/.demo-bundle/reveal-tally.mjs"
bash scripts/demo/_bundle.sh scripts/demo/reveal-tally.ts "${REVEAL_BUNDLE}"
# reveal-tally prints its payload on a line prefixed with DEMO_REVEAL_JSON= (tlock/drand also log a
# "beacon received: {...}" line to stdout — we grep out ONLY our marked payload).
REVEAL_OUT="$(REVEAL_MODE="${REVEAL_MODE}" node "${REVEAL_BUNDLE}" --manifest "${VOTES_JSON}" --proposal-id "${PROPOSAL_ID}" 2>/tmp/shadowkit-demo-reveal.log)" || {
  echo "[demo] FAIL: tlock reveal failed; tail:"; tail -15 /tmp/shadowkit-demo-reveal.log; echo "stdout:"; echo "${REVEAL_OUT}" | tail -5; exit 1;
}
REVEAL_JSON="$(printf '%s\n' "${REVEAL_OUT}" | grep '^DEMO_REVEAL_JSON=' | sed 's/^DEMO_REVEAL_JSON=//')"
[ -n "${REVEAL_JSON}" ] || { echo "[demo] FAIL: reveal produced no DEMO_REVEAL_JSON payload"; echo "${REVEAL_OUT}" | tail -8; exit 1; }
YES_W="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revealedYesW)' "${REVEAL_JSON}")"
NO_W="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).revealedNoW)' "${REVEAL_JSON}")"
DECRYPTIONS="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).decryptions))' "${REVEAL_JSON}")"
echo "    revealed weighted tally: yes=${YES_W} no=${NO_W}"

echo "==> [5b/8] close_and_reveal on-chain (re-aggregate the decryptions, decide quorum)..."
stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- close_and_reveal --id "${PROPOSAL_ID}" --revealed_yes_w "${YES_W}" --revealed_no_w "${NO_W}" \
     --decryptions "${DECRYPTIONS}" >/dev/null 2>/tmp/shadowkit-demo-close.log || {
  echo "[demo] FAIL: close_and_reveal failed; tail:"; tail -15 /tmp/shadowkit-demo-close.log; exit 1;
}
APPROVED="$(invoke_read --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- is_approved --id "${PROPOSAL_ID}")"
echo "    is_approved(${PROPOSAL_ID}) = ${APPROVED}"
[ "${APPROVED}" = "true" ] || { echo "[demo] FAIL: proposal not Approved after sealed reveal (yes=${YES_W} no=${NO_W})"; exit 1; }

if [ "${STOP_AFTER}" = "approve" ]; then
  echo "==> STOP_AFTER=approve — proposal ${PROPOSAL_ID} is APPROVED (yes=${YES_W} no=${NO_W}); not funding/executing."
  echo "DEMO_PROPOSAL_ID=${PROPOSAL_ID}"
  exit 0
fi

# ---- 6) fund the treasury with 10_000 USDC, snapshot balances ----
echo "==> [6/8] funding treasury with 10_000 USDC..."
stellar contract invoke --id "${USDC_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- mint --to "${TREASURY_ADDR}" --amount 10000 >/dev/null 2>&1 \
  || { echo "[demo] FAIL: USDC mint to treasury failed"; exit 1; }
USDC_BEFORE="$(invoke_read --id "${USDC_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
WXLM_BEFORE="$(invoke_read --id "${WXLM_SAC}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
echo "    treasury BEFORE: USDC=${USDC_BEFORE}  WXLM=${WXLM_BEFORE}"

if [ "${STOP_AFTER}" = "fund" ]; then
  echo "==> STOP_AFTER=fund — proposal ${PROPOSAL_ID} APPROVED + treasury funded (USDC=${USDC_BEFORE}); ready for the AgentBoard demo to execute live."
  echo "DEMO_PROPOSAL_ID=${PROPOSAL_ID}"
  exit 0
fi

# ---- 7) run the REAL agent middleware (watch Approved -> plan -> sign -> on-chain swap -> mark_executed) ----
echo "==> [7/8] running the REAL agent (DeterministicPlanner -> Executor -> on-chain FallbackAMM.swap)..."
AGENT_BUNDLE="${ROOT}/.demo-bundle/run-agent.mjs"
node_modules/.bin/esbuild agent/src/run-e2e.ts --bundle --platform=node --format=esm \
  --packages=external --outfile="${AGENT_BUNDLE}" >/dev/null 2>&1 \
  || { echo "[demo] FAIL: esbuild bundle of run-e2e.ts failed"; exit 1; }
PROPOSAL_ID="${PROPOSAL_ID}" \
GOV_VAULT_ID="${GOV_VAULT_ID}" \
AMM_ID="${FALLBACK_AMM_ID}" \
TREASURY_ADDR="${TREASURY_ADDR}" \
TREASURY_SECRET="${TREASURY_SECRET}" \
LOCAL_RPC_URL="${RPC_URL}" \
LOCAL_NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}" \
  node "${AGENT_BUNDLE}" || { echo "[demo] FAIL: agent run-e2e failed"; exit 1; }

# ---- 8) ASSERT real on-chain balance movement + Executed + tally revealed ----
USDC_AFTER="$(invoke_read --id "${USDC_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
WXLM_AFTER="$(invoke_read --id "${WXLM_SAC}" --source-account "${DEPLOYER}" --network "${NET}" -- balance --id "${TREASURY_ADDR}")"
FINAL_VIEW="$(stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- proposal --id "${PROPOSAL_ID}" 2>/dev/null | strip_noise | tail -1)"
echo "==> [8/8] treasury AFTER:  USDC=${USDC_AFTER}  WXLM=${WXLM_AFTER}"

USDC_DELTA=$(( USDC_AFTER - USDC_BEFORE ))
WXLM_DELTA=$(( WXLM_AFTER - WXLM_BEFORE ))
echo "    deltas: USDC=${USDC_DELTA}  WXLM=+${WXLM_DELTA}"

FAIL=0
[ "${USDC_DELTA}" -eq -10000 ] || { echo "[demo] ASSERT FAIL: expected USDC delta -10000, got ${USDC_DELTA}"; FAIL=1; }
[ "${WXLM_DELTA}" -gt 0 ]      || { echo "[demo] ASSERT FAIL: expected WXLM to INCREASE, got ${WXLM_DELTA}"; FAIL=1; }
echo "${FINAL_VIEW}" | grep -q "Executed" || { echo "[demo] ASSERT FAIL: proposal not Executed"; FAIL=1; }
# tally must be revealed (weighted_yes is now a quoted i128, e.g. "weighted_yes":"350", not null).
echo "${FINAL_VIEW}" | grep -qE '"weighted_yes":"?[0-9]' || { echo "[demo] ASSERT FAIL: tally not revealed in final view: ${FINAL_VIEW}"; FAIL=1; }
[ "${FAIL}" -eq 0 ] || { echo "[demo] ======== DEMO FAILED ========"; exit 1; }

echo "========================================================================"
echo "DEMO OK (${NETWORK})"
echo "  sealed votes cast (tally hidden) -> tlock reveal (yes=${YES_W} no=${NO_W}) -> Approved"
echo "  agent swap: USDC ${USDC_DELTA}, WXLM +${WXLM_DELTA}  (proposal ${PROPOSAL_ID} Executed)"
echo "========================================================================"
