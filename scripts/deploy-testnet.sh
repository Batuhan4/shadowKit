#!/usr/bin/env bash
# scripts/deploy-testnet.sh — deploy the FULL SEALED-ZK ShadowKit system to Stellar TESTNET.
#
# Thin wrapper over scripts/deploy-demo.sh --network testnet (ONE parameterized deploy path, local +
# testnet, charter "no code fork"). Writes .env.demo.testnet with every contract id (C... strkeys),
# the treasury wallet + secret, and the demo snapshot Merkle root. Re-runnable (the demo is designed
# to be re-run; deploy-demo re-wires merkle_root + executor each run).
#
# Usage: bash scripts/deploy-testnet.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "${ROOT}/scripts/deploy-demo.sh" --network testnet
