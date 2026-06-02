#!/usr/bin/env bash
# scripts/net-down.sh — stop the local Stellar quickstart network.
# SOURCE: stellar-docs "Manage Stellar Network Container" (verified 2026-06-02).
set -euo pipefail
echo "[net-down] stopping local Stellar quickstart container..."
stellar container stop local
echo "[net-down] stopped."
