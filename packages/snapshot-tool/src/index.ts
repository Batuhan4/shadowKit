import { leafHash, emptySubtrees } from "./merkle.js";
import { poseidonHashBls } from "@shadowkit/zk-prover/poseidon";

export interface Holder { secretCommit: string; weight: string; }
export interface Snapshot {
  root: string;
  rootBe32Hex: string;
  getPath(leafIndex: number): { merklePath: string[]; pathIndices: number[] };
  leafCount: number;
  depth: number;
}

export async function buildSnapshot(holders: Holder[], depth = 20): Promise<Snapshot> {
  const zero = await emptySubtrees(depth);
  // level 0 = leaves (padded to 2^depth with zero[0]).
  let level: string[] = [];
  for (const h of holders) level.push(await leafHash(h.secretCommit, h.weight));
  const leafCount = level.length;

  // Build the full tree level by level, caching the actual nodes so getPath can return siblings.
  const tree: string[][] = [level];
  for (let d = 0; d < depth; d++) {
    const cur = tree[d]!;
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i]!;
      const right = i + 1 < cur.length ? cur[i + 1]! : zero[d]!;
      next.push(await poseidonHashBls([left, right]));
    }
    if (next.length === 0) next.push(zero[d + 1]!);
    tree.push(next);
  }
  const root = tree[depth]![0]!;
  const rootBe32Hex = "0x" + BigInt(root).toString(16).padStart(64, "0");

  function getPath(leafIndex: number) {
    const merklePath: string[] = []; const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let d = 0; d < depth; d++) {
      const isRight = idx % 2 === 1;
      const sibIdx = isRight ? idx - 1 : idx + 1;
      const sib = sibIdx < tree[d]!.length ? tree[d]![sibIdx]! : zero[d]!;
      merklePath.push(sib);
      pathIndices.push(isRight ? 1 : 0);
      idx = Math.floor(idx / 2);
    }
    return { merklePath, pathIndices };
  }
  return { root, rootBe32Hex, getPath, leafCount, depth };
}
