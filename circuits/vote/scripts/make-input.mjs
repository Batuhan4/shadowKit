// Build a valid vote.circom input.json from a single known voter. Uses poseidonHashBls so every
// hash matches the BLS12-381 circuit. Tree: voter at index 0, all sibling subtrees empty (= Poseidon
// of zero leaves), depth 20. SOURCE: vote.circom signal layout (foundation §4).
// RUN WITH: `npx tsx circuits/vote/scripts/make-input.mjs` (NOT bare `node` — see execution note).
import { writeFileSync } from "node:fs";
import { poseidonHashBls } from "../../../packages/zk-prover/src/poseidon.js";

const DEPTH = 20;
const secret = "12345";
const weight = "1000";
const proposalId = "0";
const direction = "1";
const sealKey = "987654321";

const secretCommit = await poseidonHashBls([secret]);
const leaf = await poseidonHashBls([secretCommit, weight]);
const sealedCommitmentHash = await poseidonHashBls([direction, weight, sealKey]);
const nullifier = await poseidonHashBls([secret, proposalId]);

// Empty-subtree defaults: zero[0] = 0 leaf; zero[i] = Poseidon(zero[i-1], zero[i-1]).
const zero = ["0"];
for (let i = 1; i <= DEPTH; i++) zero.push(await poseidonHashBls([zero[i - 1], zero[i - 1]]));

// Voter is left-most leaf (all pathIndices = 0), siblings are the empty-subtree hashes.
const pathElements = []; const pathIndices = [];
let cur = leaf;
for (let i = 0; i < DEPTH; i++) {
  pathElements.push(zero[i]);
  pathIndices.push(0);
  cur = await poseidonHashBls([cur, zero[i]]);
}
const merkleRoot = cur;

const input = { merkleRoot, proposalId, sealedCommitmentHash, secret, weight, direction, pathElements, pathIndices, sealKey };
writeFileSync(new URL("../fixtures/input.json", import.meta.url), JSON.stringify(input, null, 2));
console.log("wrote input.json; nullifier =", nullifier, "root =", merkleRoot);
