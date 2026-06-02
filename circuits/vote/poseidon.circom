pragma circom 2.2.1;
// Re-export circomlib Poseidon so vote.circom + merkle.circom share one import path.
// SOURCE: iden3/circomlib circuits/poseidon.circom (template Poseidon(nInputs), out signal).
include "circomlib/circuits/poseidon.circom";
