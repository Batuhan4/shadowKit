pragma circom 2.2.1;
// Poseidon Merkle inclusion proof. circomlib has NO Merkle template, so we build one from
// Switcher (circomlib) + Poseidon. Verified: circomlib circuits/switcher.circom Switcher()
// swaps (L,R) by sel; circuits/poseidon.circom Poseidon(2) hashes a node pair.
include "circomlib/circuits/switcher.circom";
include "circomlib/circuits/poseidon.circom";

// Proves `leaf` is included in a Merkle tree of given `root`, using `pathElements`
// (sibling per level) and `pathIndices` (0 => current node is left child, 1 => right child).
template MerkleTreeChecker(depth) {
    signal input leaf;
    signal input root;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component switchers[depth];
    component hashers[depth];

    signal levelHashes[depth + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // pathIndices[i] must be a bit.
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        switchers[i] = Switcher();
        switchers[i].sel <== pathIndices[i];
        switchers[i].L <== levelHashes[i];
        switchers[i].R <== pathElements[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== switchers[i].outL;
        hashers[i].inputs[1] <== switchers[i].outR;

        levelHashes[i + 1] <== hashers[i].out;
    }

    root === levelHashes[depth];
}
