import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FX = resolve(__dirname, "../fixtures");
const pub = JSON.parse(readFileSync(resolve(FX, "public.json"), "utf8")) as string[];
const input = JSON.parse(readFileSync(resolve(FX, "input.json"), "utf8"));

// snarkjs publicSignals = [outputs..., public inputs...] = [nullifier, merkleRoot, proposalId, sealedCommitmentHash].
// The BINDING EXTERNAL order (foundation §4) is [merkleRoot, nullifier, proposalId, sealedCommitmentHash].
// @shadowkit/zk-prover re-maps snarkjs order -> binding order (Task 4.31). This test pins the snarkjs
// native indices so that re-map is grounded in fact.
describe("public.json native order", () => {
  it("public.json == [nullifier, merkleRoot, proposalId, sealedCommitmentHash]", () => {
    expect(pub.length).toBe(4);
    expect(pub[1]).toBe(input.merkleRoot);
    expect(pub[2]).toBe(input.proposalId);
    expect(pub[3]).toBe(input.sealedCommitmentHash);
    // pub[0] is the nullifier output (not in input.json); must be a field element.
    expect(/^[0-9]+$/.test(pub[0])).toBe(true);
  });
});
