// @shadowkit/snapshot-tool — STUB (foundation §3.3). Real impl: M4.
export interface Holder {
  secretCommit: string;
  weight: string;
}
export interface Snapshot {
  root: string;
  rootBe32Hex: string;
  getPath(leafIndex: number): { merklePath: string[]; pathIndices: number[] };
  leafCount: number;
  depth: number;
}
export function buildSnapshot(_holders: Holder[], _depth?: number): Snapshot {
  throw new Error("buildSnapshot: implemented in M4");
}
