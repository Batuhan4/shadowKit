pragma circom 2.2.1;
include "poseidon.circom";
include "merkle.circom";
// DEGRADED fallback circuit (spec §13.2): proves membership + nullifier + proposalId binding.
// No sealed-vote well-formedness; weight is still in the leaf but direction is NOT proven well-formed.
// Used in 1p1v mode where each accepted vote counts as weight 1.
template VoteMin(TREE_DEPTH) {
    signal input merkleRoot;
    signal input proposalId;
    signal output nullifier;
    signal input secret;
    signal input weight;
    signal input pathElements[TREE_DEPTH];
    signal input pathIndices[TREE_DEPTH];
    component sc = Poseidon(1); sc.inputs[0] <== secret;
    component leaf = Poseidon(2); leaf.inputs[0] <== sc.out; leaf.inputs[1] <== weight;
    component mt = MerkleTreeChecker(TREE_DEPTH);
    mt.leaf <== leaf.out; mt.root <== merkleRoot;
    for (var i = 0; i < TREE_DEPTH; i++) { mt.pathElements[i] <== pathElements[i]; mt.pathIndices[i] <== pathIndices[i]; }
    component nf = Poseidon(2); nf.inputs[0] <== secret; nf.inputs[1] <== proposalId; nullifier <== nf.out;
}
component main {public [merkleRoot, proposalId]} = VoteMin(20);
