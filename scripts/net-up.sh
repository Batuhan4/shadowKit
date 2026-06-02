#!/usr/bin/env bash
# scripts/net-up.sh — start the local Stellar quickstart network (Docker) and register the CLI net.
# SOURCE: stellar-docs "Start Local Stellar Network" + "Configure Stellar CLI for Local Network"
#         (verified 2026-06-02).
set -euo pipefail

echo "[net-up] starting local Stellar quickstart container..."
# NOTE: stellar 26.1.0 quickstart:testing defaults to protocol 25; soroban-sdk 26.0.0 requires
# protocol 26. Pass --protocol-version 26 so the container runs the correct protocol.
# IDEMPOTENT (demo-never-dies / `just e2e-hero` re-runs): stellar 26.1.0 `container start` errors
# "a container named \"stellar-local\" already running" (non-zero) when the net is already up. Tolerate
# that one case so repeat runs are no-ops; any OTHER start failure still surfaces (we re-check RPC health
# below, which fails the script if the container is genuinely not serving).
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "stellar-local"; then
  echo "[net-up] container 'stellar-local' already running — skipping start (idempotent)."
else
  stellar container start local --protocol-version 26
fi

echo "[net-up] registering 'local' network with the CLI..."
# stellar 26.1.0: `network add` has no --overwrite flag and is idempotent (re-add of an
# existing name exits 0), so a single add is correct and safe across net-down/net-up cycles.
stellar network add local \
  --rpc-url "http://localhost:8000/rpc" \
  --network-passphrase "Standalone Network ; February 2017"

echo "[net-up] waiting for RPC to become healthy..."
RPC_OK=0
for i in $(seq 1 60); do
  if curl -s -X POST "http://localhost:8000/rpc" \
       -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"status":"healthy"'; then
    echo "[net-up] RPC healthy."
    RPC_OK=1
    break
  fi
  sleep 2
done
[ "${RPC_OK}" = "1" ] || { echo "[net-up] ERROR: RPC did not become healthy in time." >&2; exit 1; }

# On a FRESH container the friendbot service comes up well AFTER RPC (~60-90s). The deploy script funds
# the deployer via friendbot, so a deploy that races friendbot fails "Account not found". Wait for
# friendbot to stop returning 502/000 before declaring net-up done. A 200/400 (400 == already-funded /
# bad arg, i.e. the service is alive) means friendbot is serving. (demo-never-dies fresh-net robustness.)
echo "[net-up] waiting for friendbot to become available..."
PROBE_ADDR="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
for i in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:8000/friendbot?addr=${PROBE_ADDR}" 2>/dev/null || echo 000)"
  if [ "${CODE}" = "200" ] || [ "${CODE}" = "400" ]; then
    echo "[net-up] friendbot available (http=${CODE})."
    exit 0
  fi
  sleep 3
done
echo "[net-up] ERROR: friendbot did not become available in time." >&2
exit 1
