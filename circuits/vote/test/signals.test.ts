import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// snarkjs emits public signals as: circuit OUTPUTS first, then public INPUTS in declaration order.
// vote.circom: output `nullifier`; public inputs `merkleRoot, proposalId, sealedCommitmentHash`.
// The .sym file lists every signal as: `idx,varIdx,componentIdx,name`. Main signals are the
// lowest indices after signal 0 (constant 1): [out(s), then public ins, then private ins].
describe("public signal layout", () => {
  it("orders public signals as [merkleRoot, nullifier, proposalId, sealedCommitmentHash]", () => {
    const sym = readFileSync(resolve(__dirname, "../build/vote.sym"), "utf8").trim().split("\n");
    // The witness index -> name map for the four PUBLIC wires of `main`.
    const mainPublic = sym
      .map((l) => l.split(","))
      .filter(([, , , name]) => /^main\.(merkleRoot|nullifier|proposalId|sealedCommitmentHash)$/.test(name))
      .map(([witnessIdx, , , name]) => ({ idx: Number(witnessIdx), name: name.replace("main.", "") }))
      .sort((a, b) => a.idx - b.idx);
    expect(mainPublic.map((s) => s.name)).toEqual([
      "nullifier", "merkleRoot", "proposalId", "sealedCommitmentHash",
    ]);
    // NOTE: snarkjs public.json output array == [outputs..., public inputs...] =
    // [nullifier? ...] — see Task 4.10 which fixes the canonical array order against public.json.
  });
});
