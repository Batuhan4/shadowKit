#!/usr/bin/env bash
# Regenerate the DEGRADED (fallback-2) circuit fixtures: compile vote_min.circom, local Groth16
# trusted setup over BLS12-381, export VK, produce a sample proof. Mirrors scripts/snapshot-fixtures.sh
# (same verified snarkjs CLI: powersoftau new/contribute/prepare phase2; groth16 setup; zkey
# contribute/beacon; export verificationkey; groth16 fullprove/verify) for the 3-public-signal circuit.
set -euo pipefail
cd "$(dirname "$0")/.."
CIRC=circuits/vote
FXM=$CIRC/fixtures-min
# vote_min is a depth-20 Merkle + 3 Poseidons (~12k constraints, like vote.circom minus the seal/dir
# checks). snarkjs `groth16 setup` needs the phase-2 ptau to cover 2*constraints, so 2^POW >= 2*constraints.
# 2^15 = 32768 covers it (POW<=14 is TOO SMALL for a depth-20 Merkle — same as the full circuit).
POW=15
ENTROPY="shadowkit-min-$(date +%s)"
BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
mkdir -p "$FXM" "$CIRC/build-min"

echo "== compile vote_min.circom (BLS12-381) =="
( cd "$CIRC" && circom vote_min.circom --r1cs --wasm --sym -p bls12381 -l node_modules -o build-min )

SNARKJS="npx --yes snarkjs@0.7.6"
echo "== powers of tau (bls12381) =="
$SNARKJS powersoftau new bls12381 $POW "$CIRC/build-min/pot_0.ptau" -v
$SNARKJS powersoftau contribute "$CIRC/build-min/pot_0.ptau" "$CIRC/build-min/pot_1.ptau" --name="sk-min-ptau" -e="$ENTROPY" -v
$SNARKJS powersoftau prepare phase2 "$CIRC/build-min/pot_1.ptau" "$CIRC/build-min/pot_final.ptau" -v
echo "== groth16 phase2 (zkey) =="
$SNARKJS groth16 setup "$CIRC/build-min/vote_min.r1cs" "$CIRC/build-min/pot_final.ptau" "$CIRC/build-min/vote_min_0.zkey"
$SNARKJS zkey contribute "$CIRC/build-min/vote_min_0.zkey" "$CIRC/build-min/vote_min_1.zkey" --name="sk-min-zkey" -e="$ENTROPY" -v
$SNARKJS zkey beacon "$CIRC/build-min/vote_min_1.zkey" "$FXM/vote_min_final.zkey" "$BEACON" 10 -n="sk-min-beacon"
$SNARKJS zkey export verificationkey "$FXM/vote_min_final.zkey" "$FXM/verification_key.json"
cp "$CIRC/build-min/vote_min.r1cs" "$FXM/vote_min.r1cs"
cp "$CIRC/build-min/vote_min_js/vote_min.wasm" "$FXM/vote_min.wasm"

echo "== generate input.json (npx tsx) =="
npx --yes tsx "$CIRC/scripts/make-input-min.mjs"

echo "== sample proof =="
$SNARKJS groth16 fullprove "$FXM/input.json" "$FXM/vote_min.wasm" "$FXM/vote_min_final.zkey" "$FXM/proof.json" "$FXM/public.json"
$SNARKJS groth16 verify "$FXM/verification_key.json" "$FXM/public.json" "$FXM/proof.json"
echo "== min sample proof verified OK =="
