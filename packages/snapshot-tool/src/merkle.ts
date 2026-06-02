// Poseidon Merkle tree over BLS12-381 (parity with circuits/vote/merkle.circom). leaf = Poseidon(secretCommit, weight).
// Node = Poseidon(left, right). pathIndices[i]=0 means the CURRENT node is the LEFT child at level i.
import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

export async function leafHash(secretCommit: string, weight: string): Promise<string> {
  return poseidonHashBls([secretCommit, weight]);
}

export async function emptySubtrees(depth: number): Promise<string[]> {
  const zero = ["0"];
  for (let i = 1; i <= depth; i++) zero.push(await poseidonHashBls([zero[i - 1]!, zero[i - 1]!]));
  return zero;
}
