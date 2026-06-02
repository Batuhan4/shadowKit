pragma circom 2.2.1;
include "circomlib/circuits/poseidon.circom";
template P3() { signal input in[3]; signal output out; component h = Poseidon(3); for (var i=0;i<3;i++){h.inputs[i] <== in[i];} out <== h.out; }
component main = P3();
