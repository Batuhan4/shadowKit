pragma circom 2.2.1;
include "circomlib/circuits/poseidon.circom";
template P1() { signal input in[1]; signal output out; component h = Poseidon(1); h.inputs[0] <== in[0]; out <== h.out; }
component main = P1();
