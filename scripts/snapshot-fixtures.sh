#!/usr/bin/env bash
# Regenerate ALL circuit fixtures: compile vote.circom, run a LOCAL Groth16 trusted setup
# over BLS12-381, export VK, and produce a sample proof. Toxic waste discarded (hackathon-grade,
# spec §12). Helper Poseidon wasms (§0.1) are (re)compiled too.
# SOURCE: snarkjs CLI verified 2026-06-02 via ctx7 /iden3/snarkjs:
#   powersoftau new <curve> <power> ; powersoftau contribute ; powersoftau prepare phase2 ;
#   groth16 setup ; zkey contribute ; zkey beacon ; zkey export verificationkey ;
#   groth16 fullprove ; groth16 verify.
set -euo pipefail
cd "$(dirname "$0")/.."
CIRC=circuits/vote
FX=$CIRC/fixtures
# vote.circom has ~12.5k total constraints (depth-20 Merkle + 4 Poseidons). snarkjs `groth16 setup`
# requires the phase-2 ptau to cover 2*constraints (= ~24.9k), so the power of tau must satisfy
# 2^POW >= 2*constraints. 2^15 = 32768 > 24950. (POW=12/13/14 are TOO SMALL for this circuit.)
POW=15
ENTROPY="shadowkit-hackathon-$(date +%s)"
BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

mkdir -p "$FX" "$CIRC/build"

echo "== compile vote.circom (BLS12-381) =="
( cd "$CIRC" && mkdir -p build && circom vote.circom --r1cs --wasm --sym -p bls12381 -l node_modules -o build )

echo "== compile poseidon helpers =="
for n in 1 2 3; do
  ( cd circuits/poseidon-helpers && mkdir -p build && circom poseidon$n.circom --wasm -p bls12381 -l ../vote/node_modules -o build )
  cp "circuits/poseidon-helpers/build/poseidon${n}_js/poseidon${n}.wasm" "circuits/poseidon-helpers/fixtures/"
done

SNARKJS="npx --yes snarkjs@0.7.6"

echo "== powers of tau (bls12381) =="
$SNARKJS powersoftau new bls12381 $POW "$CIRC/build/pot_0.ptau" -v
$SNARKJS powersoftau contribute "$CIRC/build/pot_0.ptau" "$CIRC/build/pot_1.ptau" --name="sk-ptau" -e="$ENTROPY" -v
$SNARKJS powersoftau prepare phase2 "$CIRC/build/pot_1.ptau" "$CIRC/build/pot_final.ptau" -v

echo "== groth16 phase2 (zkey) =="
$SNARKJS groth16 setup "$CIRC/build/vote.r1cs" "$CIRC/build/pot_final.ptau" "$CIRC/build/vote_0.zkey"
$SNARKJS zkey contribute "$CIRC/build/vote_0.zkey" "$CIRC/build/vote_1.zkey" --name="sk-zkey" -e="$ENTROPY" -v
$SNARKJS zkey beacon "$CIRC/build/vote_1.zkey" "$FX/vote_final.zkey" "$BEACON" 10 -n="sk-beacon"
$SNARKJS zkey export verificationkey "$FX/vote_final.zkey" "$FX/verification_key.json"

echo "== copy committed artifacts =="
cp "$CIRC/build/vote.r1cs" "$FX/vote.r1cs"
cp "$CIRC/build/vote_js/vote.wasm" "$FX/vote.wasm"

echo "== sample proof from fixtures/input.json (must already exist; see Task 4.8) =="
if [ -f "$FX/input.json" ]; then
  $SNARKJS groth16 fullprove "$FX/input.json" "$FX/vote.wasm" "$FX/vote_final.zkey" "$FX/proof.json" "$FX/public.json"
  $SNARKJS groth16 verify "$FX/verification_key.json" "$FX/public.json" "$FX/proof.json"
  echo "== sample proof verified OK =="
else
  echo "WARN: $FX/input.json missing — run Task 4.8 to generate a valid input first, then re-run."
fi
