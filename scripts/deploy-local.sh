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

# ---- deploy + init gov-vault, then regenerate its TS bindings (M2-0b owns binding generation) ----
GOV_WASM="target/wasm32v1-none/release/gov_vault.wasm"
test -f "${GOV_WASM}" || { echo "[deploy] ERROR: ${GOV_WASM} not found" >&2; exit 1; }

echo "[deploy] deploying gov-vault..."
GOV_VAULT_ID=$(stellar contract deploy \
  --wasm "${GOV_WASM}" \
  --source-account "${DEPLOYER}" \
  --network "${NET}" \
  --alias gov_vault)
echo "[deploy] gov_vault contract id: ${GOV_VAULT_ID}"

# Treasury asset = the USDC SAC on local; on testnet resolve the canonical USDC SAC at M6.
TREASURY_ASSET="${USDC_SAC:-${XLM_SAC:-}}"

# ---- hero-loop voters (M2-16): 3 eligible voters with weight so a proposal can pass quorum on close.
# Created + funded here and baked into gov-vault's init vote_weights so `just e2e-hero` can cast REAL
# weighted yes-votes. On testnet (no friendbot mint setup) the weights default to empty.
VOTE_WEIGHTS='{}'
if [ "${NET}" = "local" ]; then
  echo "[deploy] preparing 3 hero voters (weight 10 each)..."
  V1_ADDR=""; V2_ADDR=""; V3_ADDR=""
  for n in 1 2 3; do
    stellar keys generate "shadowkit-voter${n}" --network "${NET}" --fund \
      || echo "[deploy] voter${n} identity already exists (continuing)"
    addr="$(stellar keys address "shadowkit-voter${n}")"
    curl --silent --show-error -X POST "${FRIENDBOT_URL}?addr=${addr}" >/dev/null 2>&1 || true
    eval "V${n}_ADDR=\"${addr}\""
  done
  # i128 weights MUST be JSON strings (stellar 26.1.0: numeric i128 in a map is rejected).
  VOTE_WEIGHTS="{\"${V1_ADDR}\":\"10\",\"${V2_ADDR}\":\"10\",\"${V3_ADDR}\":\"10\"}"
  echo "[deploy] voters: ${V1_ADDR} ${V2_ADDR} ${V3_ADDR}"
fi

# init gov-vault (idempotent: a second init returns GovError::AlreadyInitialized, which we tolerate).
echo "[deploy] init gov-vault (admin=${DEPLOYER_ADDR}, treasury_asset=${TREASURY_ASSET})..."
stellar contract invoke \
  --id "${GOV_VAULT_ID}" \
  --source-account "${DEPLOYER}" \
  --network "${NET}" \
  -- init \
  --admin "${DEPLOYER_ADDR}" \
  --treasury_asset "${TREASURY_ASSET}" \
  --quorum_cfg '{ "min_voters": 3, "yes_must_exceed_no": true }' \
  --vote_weights "${VOTE_WEIGHTS}" \
  || echo "[deploy] gov-vault already initialized (continuing)"

# set_executor (Task M2-0c): authorize the AgentPolicy smart-account wallet to call mark_executed.
# The AgentPolicy wallet is deployed later in M2; until then point the executor at $AGENT_POLICY_WALLET
# if provided, else the deployer (admin-signed). This wires the foundation §2.2 auth gate into deploy.
EXECUTOR_ADDR="${AGENT_POLICY_WALLET:-${DEPLOYER_ADDR}}"
echo "[deploy] set_executor -> ${EXECUTOR_ADDR} (admin-signed; foundation §2.2 mark_executed gate)..."
stellar contract invoke \
  --id "${GOV_VAULT_ID}" \
  --source-account "${DEPLOYER}" \
  --network "${NET}" \
  -- set_executor \
  --executor "${EXECUTOR_ADDR}" \
  || echo "[deploy] set_executor failed (continuing — re-run after AgentPolicy wallet is deployed)"

# ---- regenerate @shadowkit/shared/bindings so they never drift from the deployed gov-vault ----
# (foundation §1 path packages/shared/src/bindings/<contract>; M2-0b is the single owner.)
BINDINGS_DIR="packages/shared/src/bindings/gov-vault"
echo "[deploy] regenerating TS bindings for gov-vault -> ${BINDINGS_DIR}..."
stellar contract bindings typescript \
  --contract-id "${GOV_VAULT_ID}" \
  --network "${NET}" \
  --output-dir "${BINDINGS_DIR}" \
  --overwrite

# The generated client imports type-only symbols with a value import; the repo's tsconfig.base.json
# sets verbatimModuleSyntax=true, so normalize those to inline `type` imports (idempotent — the regex
# only matches the un-normalized form). Keeps `npm run build` green without relaxing the repo standard.
GEN_INDEX="${BINDINGS_DIR}/src/index.ts"
if [ -f "${GEN_INDEX}" ]; then
  perl -0pi -e 's/^  ClientOptions as ContractClientOptions,$/  type ClientOptions as ContractClientOptions,/m;
                s/^  MethodOptions,$/  type MethodOptions,/m;
                s/^  Result,$/  type Result,/m;' "${GEN_INDEX}"
  echo "[deploy] normalized generated bindings imports for verbatimModuleSyntax"
fi

# ===========================================================================
# M2 (Task M2-15) — AgentPolicy + treasury smart-account wallet + FallbackAMM venue.
# Deploys the policy-gated treasury stack the hero loop (Task M2-16 `just e2e-hero`) drives:
#   * FallbackAMM (the approved swap venue) + seeded USDC/WXLM liquidity
#   * AgentPolicy (the OZ Smart Account custom policy contract)
#   * a treasury wallet identity (the session/agent account that holds USDC and signs the swap)
#   * set_executor -> treasury (so the treasury may call gov-vault.mark_executed; foundation §2.2)
# All ids are appended to .env.local so `just e2e-hero` consumes a single source of truth.
#
# CLEAN-OUTPUT ASSET NOTE: the hero loop's asset_out is a CUSTOM WXLM SAC (NOT native XLM). Native
# XLM is the fee asset, so a native-XLM treasury balance is dominated by tx fees and cannot show a
# clean +amount_out delta. A custom WXLM SAC gives a fee-independent balance so the e2e can assert an
# exact +amount_out on-chain (mirrors the in-Env hero_loop_moves_balances which uses a pure SAC).
echo "[deploy] ===== M2: AgentPolicy + treasury + FallbackAMM ====="

# Only the LOCAL network supports the full mint/trustline-driven hero treasury setup here; on testnet
# the custom-asset minting + LP funding is an M6 concern (canonical USDC issuer). Skip the M2 block on
# testnet (gov-vault/SACs above are still deployed).
if [ "${NET}" = "local" ]; then
  # ---- custom WXLM SAC (fee-clean asset_out for the hero swap) ----
  echo "[deploy] deploying custom WXLM SAC on local (issuer=${DEPLOYER_ADDR})..."
  WXLM_SAC=$(deploy_or_resolve_sac "WXLM:${DEPLOYER_ADDR}")
  echo "[deploy] WXLM SAC id: ${WXLM_SAC}"

  # ---- deploy FallbackAMM (the AgentPolicy-approved swap venue) ----
  AMM_WASM="target/wasm32v1-none/release/fallback_amm.wasm"
  test -f "${AMM_WASM}" || { echo "[deploy] ERROR: ${AMM_WASM} not found" >&2; exit 1; }
  echo "[deploy] deploying fallback-amm..."
  AMM_ID=$(stellar contract deploy \
    --wasm "${AMM_WASM}" \
    --source-account "${DEPLOYER}" \
    --network "${NET}" \
    --alias fallback_amm)
  echo "[deploy] fallback_amm contract id: ${AMM_ID}"

  # init the AMM pool (USDC, WXLM). Idempotent: a second init returns AmmError::AlreadyInitialized.
  stellar contract invoke --id "${AMM_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- init --asset_a "${USDC_SAC}" --asset_b "${WXLM_SAC}" \
    >/dev/null 2>&1 || echo "[deploy] fallback-amm already initialized (continuing)"

  # ---- seed liquidity from the deployer (issuer holds infinite USDC; mint WXLM to itself first) ----
  # The deployer is the USDC + WXLM issuer. The issuer cannot mint to ITSELF (operation invalid on
  # issuer; the issuer already has an infinite balance and can SEND), so add_liquidity pulls both
  # assets straight from the issuer's balances. Reserves seeded to 1_000_000 / 1_000_000 once.
  RES=$(stellar contract invoke --id "${AMM_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- reserves 2>/dev/null || echo '["0","0"]')
  case "${RES}" in
    *'"0","0"'*|'["0","0"]')
      # Seed a DEEP pool (100M / 100M) so a 10_000-in swap yields ~9_969 out (≈1:1, 0.3% fee + minimal
      # slippage). This keeps the agent's DeterministicPlanner minOut (price=1, 50bps -> 9_950) BELOW the
      # realized out so the live swap passes the AMM slippage guard. (A shallow 1M pool would return
      # ~9_871, under the 9_950 floor, and the swap would revert SlippageExceeded.)
      echo "[deploy] seeding AMM liquidity (100_000_000 USDC + 100_000_000 WXLM from issuer)..."
      stellar contract invoke --id "${AMM_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
        -- add_liquidity --from "${DEPLOYER_ADDR}" --amount_a 100000000 --amount_b 100000000 \
        >/dev/null 2>&1 || echo "[deploy] add_liquidity returned non-zero (maybe already seeded) — continuing"
      ;;
    *) echo "[deploy] AMM already has liquidity (${RES}) — skipping seed" ;;
  esac

  # ---- deploy the AgentPolicy (OZ Smart Account custom policy) ----
  AGENT_POLICY_WASM="target/wasm32v1-none/release/agent_policy.wasm"
  test -f "${AGENT_POLICY_WASM}" || { echo "[deploy] ERROR: ${AGENT_POLICY_WASM} not found" >&2; exit 1; }
  echo "[deploy] deploying agent-policy (OZ smart-account custom policy)..."
  AGENT_POLICY_ID=$(stellar contract deploy \
    --wasm "${AGENT_POLICY_WASM}" \
    --source-account "${DEPLOYER}" \
    --network "${NET}" \
    --alias agent_policy)
  echo "[deploy] agent_policy contract id: ${AGENT_POLICY_ID}"
  # NOTE (stellar 26.1.0 CLI drift — documented): `stellar contract invoke` CANNOT call ANY entrypoint
  # on agent-policy (install / params / probe_cross_read all fail "Missing Entry Context"). The
  # contract's exported spec references the OZ `Context` UDT (from `Policy::enforce(context: Context,
  # ..)`), whose nested element type the CLI's spec resolver cannot dereference, so it rejects the
  # WHOLE contract for invoke. The policy `install` (which seeds AgentPolicyParams into the host) and
  # the host's session-key-signed `__check_auth` -> `enforce` gating path are therefore driven IN-ENV
  # (agent-policy unit + integration tests: hero_loop_moves_balances / cross_read_in_enforce_during_auth
  # / execute_without_quorum_is_blocked), NOT via the live CLI. The deploy above proves the policy WASM
  # builds + deploys on-chain. See scripts/e2e-hero.sh + the M2 Verification log for the full rationale.

  # ---- treasury wallet identity (the session/agent account holding USDC, signing the hero swap) ----
  echo "[deploy] ensuring treasury identity '${TREASURY_KEY:-shadowkit-treasury}'..."
  TREASURY_KEY="${TREASURY_KEY:-shadowkit-treasury}"
  stellar keys generate "${TREASURY_KEY}" --network "${NET}" --fund \
    || echo "[deploy] treasury identity ${TREASURY_KEY} already exists (continuing)"
  TREASURY_ADDR="$(stellar keys address "${TREASURY_KEY}")"
  curl --silent --show-error -X POST "${FRIENDBOT_URL}?addr=${TREASURY_ADDR}" >/dev/null \
    || echo "[deploy] treasury friendbot fund non-zero (likely already funded) — continuing"
  echo "[deploy] treasury wallet address: ${TREASURY_ADDR}"

  # treasury trustlines so it can hold the custom USDC + WXLM SACs (classic accounts need trustlines).
  stellar tx new change-trust --source-account "${TREASURY_KEY}" --network "${NET}" \
    --line "USDC:${DEPLOYER_ADDR}" >/dev/null 2>&1 \
    || echo "[deploy] treasury USDC trustline already exists (continuing)"
  stellar tx new change-trust --source-account "${TREASURY_KEY}" --network "${NET}" \
    --line "WXLM:${DEPLOYER_ADDR}" >/dev/null 2>&1 \
    || echo "[deploy] treasury WXLM trustline already exists (continuing)"

  # ---- re-point gov-vault.set_executor at the treasury wallet (foundation §2.2 mark_executed gate) ----
  echo "[deploy] set_executor -> treasury ${TREASURY_ADDR} (admin-signed)..."
  stellar contract invoke --id "${GOV_VAULT_ID}" --source-account "${DEPLOYER}" --network "${NET}" \
    -- set_executor --executor "${TREASURY_ADDR}" \
    >/dev/null 2>&1 || echo "[deploy] set_executor(treasury) non-zero — continuing"

  # ---- single source of truth for ids: .env.local (consumed by scripts/e2e-hero.sh) ----
  ENV_LOCAL=".env.local"
  echo "[deploy] writing deployed ids to ${ENV_LOCAL}..."
  {
    echo "# Auto-generated by scripts/deploy-local.sh — local hero-loop deploy ids (DO NOT COMMIT)."
    echo "DEPLOYER_ADDR=${DEPLOYER_ADDR}"
    echo "HELLO_ID=${HELLO_ID}"
    echo "GOV_VAULT_ID=${GOV_VAULT_ID}"
    echo "XLM_SAC=${XLM_SAC}"
    echo "USDC_SAC=${USDC_SAC}"
    echo "WXLM_SAC=${WXLM_SAC}"
    echo "AMM_ID=${AMM_ID}"
    echo "AGENT_POLICY_ID=${AGENT_POLICY_ID}"
    echo "TREASURY_KEY=${TREASURY_KEY}"
    echo "TREASURY_ADDR=${TREASURY_ADDR}"
    echo "V1_ADDR=${V1_ADDR:-}"
    echo "V2_ADDR=${V2_ADDR:-}"
    echo "V3_ADDR=${V3_ADDR:-}"
  } > "${ENV_LOCAL}"

  echo "[deploy] M2 DONE. amm=${AMM_ID} agent_policy=${AGENT_POLICY_ID} treasury=${TREASURY_ADDR} wxlm=${WXLM_SAC}"
else
  echo "[deploy] testnet: skipping M2 treasury/AMM/agent-policy block (custom-asset hero setup is local-only; testnet wiring is M6)."
fi

echo "[deploy] DONE. hello_world=${HELLO_ID} gov_vault=${GOV_VAULT_ID} xlm_sac=${XLM_SAC:-n/a} bindings=${BINDINGS_DIR}"
