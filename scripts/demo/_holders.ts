// scripts/demo/_holders.ts — the SINGLE source of truth for the demo snapshot.
//
// The demo's 3 holders (fixed secrets so the snapshot Merkle root is deterministic and the gov-vault
// can be init'd with it at deploy time). 2 YES (200 + 150 = 350 weight) vs 1 NO (300) -> yes>no AND
// 3 voters >= min_voters(3) -> the proposal APPROVES, so the agent executes the swap (the showcase).
//
// secretCommit = Poseidon(secret) and leaf = Poseidon(secretCommit, weight) (vote.circom constraint
// #1). compute-root.ts and gen-sealed-votes.ts both build the snapshot from THIS list so the on-chain
// merkle_root (set at deploy) equals the root the proofs are generated against (StaleMerkleRoot guard).
export interface DemoHolder { secret: string; weight: string; direction: 0 | 1; }

export const DEMO_HOLDERS: DemoHolder[] = [
  { secret: "111111", weight: "200", direction: 1 }, // yes
  { secret: "222222", weight: "150", direction: 1 }, // yes
  { secret: "333333", weight: "300", direction: 0 }, // no
];
