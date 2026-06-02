pragma circom 2.2.1;
include "poseidon.circom";   // circomlib Poseidon (re-export)
include "merkle.circom";     // MerkleTreeChecker(TREE_DEPTH)

// TREE_DEPTH is BINDING and must equal snapshot-tool's depth (default 20).
template Vote(TREE_DEPTH) {
    // ---- PUBLIC SIGNALS (order BINDING; matches GovVault pub_signals & §3 PublicSignals) ----
    signal input merkleRoot;             // [0] snapshot root
    signal input proposalId;             // [2] binds proof to a proposal (anti-replay)
    signal input sealedCommitmentHash;   // [3] hash committing to the sealed ciphertext
    signal output nullifier;             // [1] = Poseidon(secret, proposalId)

    // ---- PRIVATE INPUTS ----
    signal input secret;                 // voter private scalar
    signal input weight;                 // token weight (hidden)
    signal input direction;              // vote choice {0,1} (hidden; sealed off-circuit)
    signal input pathElements[TREE_DEPTH];
    signal input pathIndices[TREE_DEPTH];
    signal input sealKey;                // randomness binding the ciphertext commitment

    // 1) leaf = Poseidon(Poseidon(secret), weight)
    component secretCommit = Poseidon(1); secretCommit.inputs[0] <== secret;
    component leaf = Poseidon(2); leaf.inputs[0] <== secretCommit.out; leaf.inputs[1] <== weight;

    // 2) Merkle membership
    component mt = MerkleTreeChecker(TREE_DEPTH);
    mt.leaf <== leaf.out; mt.root <== merkleRoot;
    for (var i = 0; i < TREE_DEPTH; i++) { mt.pathElements[i] <== pathElements[i]; mt.pathIndices[i] <== pathIndices[i]; }

    // 3) nullifier = Poseidon(secret, proposalId)
    component nf = Poseidon(2); nf.inputs[0] <== secret; nf.inputs[1] <== proposalId; nullifier <== nf.out;

    // 4) direction is a bit
    direction * (direction - 1) === 0;

    // 5) sealed-vote well-formedness: sealedCommitmentHash = Poseidon(direction, weight, sealKey)
    component sc = Poseidon(3);
    sc.inputs[0] <== direction; sc.inputs[1] <== weight; sc.inputs[2] <== sealKey;
    sealedCommitmentHash === sc.out;
}
component main {public [merkleRoot, proposalId, sealedCommitmentHash]} = Vote(20);
