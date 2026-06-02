#!/usr/bin/env bash
# scripts/deploy-demo.sh — deploy the FULL SEALED-ZK ShadowKit system for the e2e demo.
#
# Parameterized by --network local|testnet (ONE code path, config switch only). Deploys:
#   * groth16-verifier (BLS12-381, embedded VK)            — verifies the on-chain vote proofs
#   * gov-vault (SEALED) init'd with the verifier id + the DEMO snapshot Merkle root
#   * USDC + WXLM SACs (custom on local; native XLM + treasury asset on testnet)
#   * FallbackAMM (the approved swap venue) + seeded deep liquidity
#   * agent-policy (OZ smart-account custom policy)        — deployed on-chain (proof it builds)
#   * a treasury wallet identity (holds USDC, signs the swap) + trustlines
#   * set_executor -> treasury (gov-vault.mark_executed auth gate; foundation §2.2)
# Writes all ids to .env.demo.<network>. Idempotent-ish: re-running redeploys fresh contract ids
# (the demo is designed to be re-run; merkle_root + executor are re-wired each run).
#
# All `stellar` subcommands were verified against the installed CLI (stellar 26.1.0) — see the M0/M2
# deploy scripts for the documented forms (`keys generate` no --global, `contract id asset` no
# --source-account, SAC ExistingValue idempotency). The SEALED gov-vault `init` arg shapes
# (--verifier Address, --merkle_root 32_hex_bytes, --quorum_cfg JSON) were confirmed by dry-running
# `init --help` against a local sealed deploy (Task 10.1 verify step).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

NET=local
while [ $# -gt 0 ]; do case "$1" in --network) NET="$2"; shift 2;; *) shift;; esac; done

# Load .env for friendbot urls / deployer identity / network passphrases.
if [ -f ./.env ]; then set -a; . ./.env; set +a; fi

DEPLOYER="${STELLAR_DEPLOYER:-shadowkit-deployer}"
TREASURY_KEY="${TREASURY_KEY:-shadowkit-treasury}"

if [ "${NET}" = "testnet" ]; then
  RPC_URL="${TESTNET_RPC_URL:-https://soroban-testnet.stellar.org}"
  NET_PASSPHRASE="${TESTNET_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
  FRIENDBOT_URL="${TESTNET_FRIENDBOT_URL:-https://friendbot.stellar.org/}"
else
  RPC_URL="${LOCAL_RPC_URL:-http://localhost:8000/rpc}"
  NET_PASSPHRASE="${LOCAL_NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
  FRIENDBOT_URL="${LOCAL_FRIENDBOT_URL:-http://localhost:8000/friendbot}"
fi

echo "[deploy-demo] network=${NET} deployer=${DEPLOYER}"

strip_noise() { grep -vE "local config|config migrate" || true; }
inv() { stellar contract invoke "$@" 2>/dev/null | strip_noise | tail -1 | tr -d '"'; }

# ---- ensure + fund deployer ----
stellar keys generate "${DEPLOYER}" --network "${NET}" --fund 2>/dev/null \
  || echo "[deploy-demo] deployer identity exists (continuing)"
DEPLOYER_ADDR="$(stellar keys address "${DEPLOYER}")"
curl --silent --show-error -X POST "${FRIENDBOT_URL}?addr=${DEPLOYER_ADDR}" >/dev/null 2>&1 \
  || echo "[deploy-demo] deployer friendbot fund non-zero (likely already funded) — continuing"
echo "[deploy-demo] deployer: ${DEPLOYER_ADDR}"

# ---- build wasm ----
echo "[deploy-demo] building contracts..."
stellar contract build >/dev/null

deploy() { # $1 = crate name (dashes); echoes contract id
  stellar contract deploy --wasm "target/wasm32v1-none/release/${1//-/_}.wasm" \
    --source-account "${DEPLOYER}" --network "${NET}" 2>/dev/null | strip_noise | tail -1
}

echo "[deploy-demo] deploying contracts..."
VERIFIER_ID=$(deploy groth16-verifier)
GOV_VAULT_ID=$(deploy gov-vault)
AMM_ID=$(deploy fallback-amm)
AGENT_POLICY_ID=$(deploy agent-policy)
# swap-venue (the Soroswap adapter) only builds a cdylib under `--features soroswap`; the PRIMARY demo
# uses FallbackAMM, so the adapter wasm is OPTIONAL. Deploy it only if the wasm is present.
SWAP_VENUE_ID=""
if [ -f "target/wasm32v1-none/release/swap_venue.wasm" ]; then
  SWAP_VENUE_ID=$(deploy swap-venue) || SWAP_VENUE_ID=""
fi
echo "[deploy-demo] verifier=${VERIFIER_ID} gov=${GOV_VAULT_ID} amm=${AMM_ID} policy=${AGENT_POLICY_ID} venue=${SWAP_VENUE_ID:-<fallback-amm only>}"
for v in VERIFIER_ID GOV_VAULT_ID AMM_ID AGENT_POLICY_ID; do
  case "$(eval echo \$$v)" in C*) ;; *) echo "[deploy-demo] FAIL: ${v} is not a contract id"; exit 1;; esac
done

# ---- SAC tokens: custom USDC + WXLM (local), native + custom WXLM (testnet uses a custom USDC SAC) ----
deploy_or_resolve_sac() {
  local asset="$1" result
  result=$(stellar contract asset deploy --source-account "${DEPLOYER}" --network "${NET}" \
            --asset "${asset}" 2>/dev/null | strip_noise | tail -1) \
    || result=$(stellar contract id asset --network "${NET}" --asset "${asset}" 2>/dev/null | strip_noise | tail -1)
  echo "${result}"
}

XLM_ID=$(stellar contract id asset --network "${NET}" --asset native 2>/dev/null | strip_noise | tail -1)
USDC_ID=$(deploy_or_resolve_sac "USDC:${DEPLOYER_ADDR}")
WXLM_ID=$(deploy_or_resolve_sac "WXLM:${DEPLOYER_ADDR}")
echo "[deploy-demo] USDC SAC=${USDC_ID}  WXLM SAC=${WXLM_ID}  XLM SAC=${XLM_ID}"
case "${USDC_ID}" in C*) ;; *) echo "[deploy-demo] FAIL: USDC SAC unresolved"; exit 1;; esac
case "${WXLM_ID}" in C*) ;; *) echo "[deploy-demo] FAIL: WXLM SAC unresolved"; exit 1;; esac

# ---- compute the DEMO snapshot Merkle root (the proofs are generated against THIS root) ----
echo "[deploy-demo] computing demo snapshot merkle root..."
ROOT_BUNDLE="${ROOT}/.demo-bundle/compute-root.mjs"
bash scripts/demo/_bundle.sh scripts/demo/compute-root.ts "${ROOT_BUNDLE}"
MERKLE_ROOT="$(node "${ROOT_BUNDLE}")"
case "${MERKLE_ROOT}" in [0-9a-f]*) ;; *) echo "[deploy-demo] FAIL: bad merkle root '${MERKLE_ROOT}'"; exit 1;; esac
echo "[deploy-demo] merkle_root=${MERKLE_ROOT}"

# ---- init the SEALED gov-vault (verifier + snapshot root + treasury asset + quorum) ----
echo "[deploy-demo] init gov-vault (sealed)..."
stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- init --admin "${DEPLOYER_ADDR}" --verifier "${VERIFIER_ID}" --merkle_root "${MERKLE_ROOT}" \
     --treasury_asset "${USDC_ID}" --quorum_cfg '{ "min_voters": 3, "yes_must_exceed_no": true }' \
  >/dev/null 2>&1 || echo "[deploy-demo] gov-vault already initialized (continuing)"

# ---- FallbackAMM init + deep liquidity (USDC<->WXLM) ----
echo "[deploy-demo] init + seed FallbackAMM..."
stellar contract invoke --id "${AMM_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- init --asset_a "${USDC_ID}" --asset_b "${WXLM_ID}" >/dev/null 2>&1 \
  || echo "[deploy-demo] amm already initialized (continuing)"
# NOTE: inv() strips quotes (tr -d '"'), so the reserves view returns the form `[0,0]` (NOT
# `["0","0"]`). Match the stripped form, else a fresh pool is wrongly seen as "already seeded".
RES=$(inv --id "${AMM_ID}" --source-account "${DEPLOYER}" --network "${NET}" -- reserves || echo '[0,0]')
case "${RES}" in
  '[0,0]'|*'[0,0]'*|*'"0","0"'*)
    # Deep pool (100M/100M) so a 10_000-in swap clears the AMM slippage guard (matches deploy-local).
    echo "[deploy-demo] seeding AMM liquidity (100M USDC + 100M WXLM from issuer)..."
    stellar contract invoke --id "${AMM_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
      -- add_liquidity --from "${DEPLOYER_ADDR}" --amount_a 100000000 --amount_b 100000000 \
      >/dev/null 2>&1 || { echo "[deploy-demo] FAIL: add_liquidity failed (no liquidity = no demo swap)"; exit 1; }
    ;;
  *) echo "[deploy-demo] AMM already has liquidity (${RES}) — skipping seed" ;;
esac

# ---- treasury wallet (holds USDC, signs the swap) + trustlines ----
echo "[deploy-demo] ensuring treasury wallet '${TREASURY_KEY}'..."
stellar keys generate "${TREASURY_KEY}" --network "${NET}" --fund 2>/dev/null \
  || echo "[deploy-demo] treasury identity exists (continuing)"
TREASURY_ADDR="$(stellar keys address "${TREASURY_KEY}")"
curl --silent --show-error -X POST "${FRIENDBOT_URL}?addr=${TREASURY_ADDR}" >/dev/null 2>&1 \
  || echo "[deploy-demo] treasury friendbot fund non-zero (continuing)"
stellar tx new change-trust --source-account "${TREASURY_KEY}" --network "${NET}" \
  --line "USDC:${DEPLOYER_ADDR}" >/dev/null 2>&1 || echo "[deploy-demo] USDC trustline exists (continuing)"
stellar tx new change-trust --source-account "${TREASURY_KEY}" --network "${NET}" \
  --line "WXLM:${DEPLOYER_ADDR}" >/dev/null 2>&1 || echo "[deploy-demo] WXLM trustline exists (continuing)"
echo "[deploy-demo] treasury: ${TREASURY_ADDR}"

# ---- set_executor -> treasury (the mark_executed auth gate; foundation §2.2) ----
echo "[deploy-demo] set_executor -> treasury..."
stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
  -- set_executor --executor "${TREASURY_ADDR}" >/dev/null 2>&1 \
  || { echo "[deploy-demo] FAIL: set_executor(treasury) failed"; exit 1; }

# ---- reveal deployer + treasury secrets (CLI exposes `keys secret`; `keys show` is an alias) ----
DEPLOYER_SECRET="$(stellar keys secret "${DEPLOYER}" 2>/dev/null | strip_noise | tail -1)"
TREASURY_SECRET="$(stellar keys secret "${TREASURY_KEY}" 2>/dev/null | strip_noise | tail -1)"

# ---- write .env.demo.<network> (single source of truth for the demo loop) ----
ENV_OUT=".env.demo.${NET}"
echo "[deploy-demo] writing ${ENV_OUT}..."
cat > "${ENV_OUT}" <<EOF
# Auto-generated by scripts/deploy-demo.sh (network=${NET}) — DO NOT COMMIT.
STELLAR_NETWORK=${NET}
RPC_URL=${RPC_URL}
# Quoted: the passphrase contains spaces + a ';' that would otherwise break \`set -a; . file\`.
NETWORK_PASSPHRASE="${NET_PASSPHRASE}"
DEPLOYER_ADDR=${DEPLOYER_ADDR}
DEPLOYER_SECRET=${DEPLOYER_SECRET}
GROTH16_VERIFIER_ID=${VERIFIER_ID}
GOV_VAULT_ID=${GOV_VAULT_ID}
FALLBACK_AMM_ID=${AMM_ID}
AMM_ID=${AMM_ID}
AGENT_POLICY_ID=${AGENT_POLICY_ID}
SWAP_VENUE_ID=${SWAP_VENUE_ID}
SOROSWAP_ADAPTER_ID=${SWAP_VENUE_ID}
USDC_ID=${USDC_ID}
USDC_SAC=${USDC_ID}
WXLM_SAC=${WXLM_ID}
WXLM_ID=${WXLM_ID}
XLM_ID=${XLM_ID}
TREASURY_KEY=${TREASURY_KEY}
TREASURY_ADDR=${TREASURY_ADDR}
TREASURY_SECRET=${TREASURY_SECRET}
MERKLE_ROOT=${MERKLE_ROOT}
SWAP_VENUE=${SWAP_VENUE:-fallback}
EOF
echo "[deploy-demo] ${ENV_OUT} written. Deploy complete (network=${NET})."
