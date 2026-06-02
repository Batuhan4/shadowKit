#!/usr/bin/env bash
# scripts/net-up.sh — start the local Stellar quickstart network (Docker) and register the CLI net.
# SOURCE: stellar-docs "Start Local Stellar Network" + "Configure Stellar CLI for Local Network"
#         (verified 2026-06-02).
set -euo pipefail

echo "[net-up] starting local Stellar quickstart container..."
stellar container start local

echo "[net-up] registering 'local' network with the CLI..."
stellar network add local \
  --rpc-url "http://localhost:8000/rpc" \
  --network-passphrase "Standalone Network ; February 2017" \
  --overwrite || \
stellar network add local \
  --rpc-url "http://localhost:8000/rpc" \
  --network-passphrase "Standalone Network ; February 2017"

echo "[net-up] waiting for RPC to become healthy..."
for i in $(seq 1 60); do
  if curl -s -X POST "http://localhost:8000/rpc" \
       -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"status":"healthy"'; then
    echo "[net-up] RPC healthy."
    exit 0
  fi
  sleep 2
done
echo "[net-up] ERROR: RPC did not become healthy in time." >&2
exit 1
