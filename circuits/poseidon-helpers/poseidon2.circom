pragma circom 2.2.1;
include "circomlib/circuits/poseidon.circom";
template P2() { signal input in[2]; signal output out; component h = Poseidon(2); h.inputs[0] <== in[0]; h.inputs[1] <== in[1]; out <== h.out; }
component main = P2();
