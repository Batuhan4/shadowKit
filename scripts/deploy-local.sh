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
# NOTE: stellar 26.1.0 removed `--global`; keys are stored in $XDG_CONFIG_HOME/stellar by default.
stellar keys generate "${DEPLOYER}" --network "${NET}" --fund \
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
# Helper: deploy a SAC or resolve its id if already deployed (idempotent).
# stellar contract asset deploy fails with Error(Storage, ExistingValue) when the SAC already
# exists (e.g. same network after multiple deploy cycles); fall back to id-only resolution.
deploy_or_resolve_sac() {
  local asset="$1"
  local result
  result=$(stellar contract asset deploy \
    --source-account "${DEPLOYER}" \
    --network "${NET}" \
    --asset "${asset}" 2>/dev/null) \
  || result=$(stellar contract id asset \
    --network "${NET}" \
    --asset "${asset}" 2>/dev/null)
  echo "${result}"
}

if [ "${NET}" = "local" ]; then
  echo "[deploy] deploying native (XLM) SAC on local..."
  XLM_SAC=$(deploy_or_resolve_sac "native")
  echo "[deploy] XLM SAC id: ${XLM_SAC}"

  echo "[deploy] deploying custom USDC SAC on local (issuer=${DEPLOYER_ADDR})..."
  USDC_SAC=$(deploy_or_resolve_sac "USDC:${DEPLOYER_ADDR}")
  echo "[deploy] USDC SAC id: ${USDC_SAC}"
else
  echo "[deploy] testnet: resolving existing SAC ids (native SAC already exists on testnet)..."
  # NOTE: stellar 26.1.0 removed --source-account from `stellar contract id asset`; only --network needed.
  XLM_SAC=$(stellar contract id asset \
    --network "${NET}" \
    --asset native 2>/dev/null)
  echo "[deploy] XLM SAC id (resolved): ${XLM_SAC}"
  echo "[deploy] testnet USDC: use the canonical testnet USDC issuer at M6; skipping custom issue here."
fi

echo "[deploy] DONE. hello_world=${HELLO_ID} xlm_sac=${XLM_SAC:-n/a}"
