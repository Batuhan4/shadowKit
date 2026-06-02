// Build a valid vote_min.circom input.json (membership + nullifier + proposalId only).
// RUN WITH: `npx tsx circuits/vote/scripts/make-input-min.mjs`
import { writeFileSync } from "node:fs";
import { poseidonHashBls } from "../../../packages/zk-prover/src/poseidon.js";

const DEPTH = 20;
const secret = "12345", weight = "1000", proposalId = "0";
const secretCommit = await poseidonHashBls([secret]);
const leaf = await poseidonHashBls([secretCommit, weight]);
const nullifier = await poseidonHashBls([secret, proposalId]);
const zero = ["0"]; for (let i = 1; i <= DEPTH; i++) zero.push(await poseidonHashBls([zero[i - 1], zero[i - 1]]));
const pathElements = [], pathIndices = [];
let cur = leaf;
for (let i = 0; i < DEPTH; i++) { pathElements.push(zero[i]); pathIndices.push(0); cur = await poseidonHashBls([cur, zero[i]]); }
const input = { merkleRoot: cur, proposalId, secret, weight, pathElements, pathIndices };
writeFileSync(new URL("../fixtures-min/input.json", import.meta.url), JSON.stringify(input, null, 2));
console.log("wrote fixtures-min/input.json; nullifier =", nullifier, "root =", cur);
